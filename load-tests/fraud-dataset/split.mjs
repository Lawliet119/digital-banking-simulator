import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import {
  resolve,
  dirname,
  basename,
  relative,
  isAbsolute,
  join,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { generateFraudDataset } from "./generate-fraud.mjs";

const columns =
  "tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario".split(
    ",",
  );
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Allocate customers before generating edges: both endpoints and their histories stay together. */
export function generateSplitDataset({
  seed = "dbs-split-v1",
  customers = 4000,
  days = 60,
} = {}) {
  if (typeof seed !== "string" || seed.length < 1 || seed.length > 128)
    throw new Error("seed must be 1–128 characters");
  if (
    !Number.isSafeInteger(customers) ||
    customers < 3334 ||
    customers > 100000
  )
    throw new Error("customers must be 3334–100000 (at least 1000 per cohort)");
  if (!Number.isSafeInteger(days) || days < 30 || days > 90)
    throw new Error("days must be 30–90");
  // Integer arithmetic avoids a binary floating-point rounding error at an exact 70% boundary.
  const tuneCount = Math.floor((customers * 7) / 10);
  const tune = generateFraudDataset({
    seed: digest(JSON.stringify([seed, "tune"])),
    customers: tuneCount,
    days,
  });
  const holdout = generateFraudDataset({
    seed: digest(JSON.stringify([seed, "holdout"])),
    customers: customers - tuneCount,
    days,
  });
  const ids = new Set(tune.simulation.customers.map((c) => c.customerId));
  if (holdout.simulation.customers.some((c) => ids.has(c.customerId)))
    throw new Error("customer namespace collision");
  return { tune, holdout };
}

// Resolve existing ancestors so a junction/symlink cannot disguise a sealed path inside a checkout.
export function canonical(path) {
  let parent = resolve(path);
  const suffix = [];
  while (!existsSync(parent)) {
    suffix.unshift(basename(parent));
    const next = dirname(parent);
    if (next === parent) throw new Error("output parent does not exist");
    parent = next;
  }
  return resolve(realpathSync(parent), ...suffix);
}
function contains(parent, child) {
  const r = relative(parent, child);
  return (
    r === "" || (!r.startsWith(".." + sep) && r !== ".." && !isAbsolute(r))
  );
}
export function insideCheckout(path) {
  for (let p = path; ; p = dirname(p)) {
    if (existsSync(join(p, ".git"))) return true;
    if (dirname(p) === p) return false;
  }
}

/**
 * Reads a secret seed from a file, so it never appears in a command line, a shell history or a
 * process list (BL-171). Drops exactly one trailing newline; rejects a BOM, control characters and
 * padding. With `checkoutGuard` the file must live outside every git checkout, so a secret seed
 * cannot be committed by accident. Errors carry no detail: a path or a seed may be private.
 */
export function readSeedFile(path, { checkoutGuard = false } = {}) {
  if (checkoutGuard && insideCheckout(canonical(path))) throw new Error();
  const raw = readFileSync(path, "utf8");
  if (raw.startsWith("﻿")) throw new Error();
  const seed = raw.endsWith("\r\n")
    ? raw.slice(0, -2)
    : raw.endsWith("\n")
      ? raw.slice(0, -1)
      : raw;
  if (
    !seed ||
    seed.length > 128 ||
    /[\p{Cc}\p{Cf}]/u.test(seed) ||
    seed.trim() !== seed
  )
    throw new Error();
  return seed;
}
function manifest(part) {
  return {
    version: 1,
    columns,
    sha256: digest(part.csv),
    customers: part.simulation.customers.length,
    transactions: part.stats.transactions,
  };
}

/** privateDir is explicitly supplied by the dataset custodian after verifying access controls. */
export function writeSplit(data, { tuneDir, privateDir } = {}) {
  if (typeof tuneDir !== "string" || !tuneDir)
    throw new Error("tune-dir is required");
  const tune = canonical(tuneDir),
    sealed = privateDir === undefined ? undefined : canonical(privateDir);
  if (existsSync(tune) || (sealed && existsSync(sealed)))
    throw new Error("output directory already exists");
  if (
    sealed &&
    (insideCheckout(sealed) || contains(tune, sealed) || contains(sealed, tune))
  )
    throw new Error(
      "private-dir must be outside every checkout and separate from tune-dir",
    );
  // Every destination is checked before creating either package. A manifest is the completion marker.
  for (const p of [tune, sealed].filter(Boolean)) {
    mkdirSync(dirname(p), { recursive: true });
    mkdirSync(p, { mode: 0o700 });
  }
  const write = (p, name, body) =>
    writeFileSync(join(p, name), body, { flag: "wx", mode: 0o600 });
  write(tune, "tune.csv", data.tune.csv);
  if (sealed) {
    write(sealed, "holdout.csv", data.holdout.csv);
    write(
      sealed,
      "simulation.json",
      JSON.stringify(data.holdout.simulation, null, 2) + "\n",
    );
    write(
      sealed,
      "manifest.json",
      JSON.stringify(manifest(data.holdout), null, 2) + "\n",
    );
  }
  write(
    tune,
    "manifest.json",
    JSON.stringify(manifest(data.tune), null, 2) + "\n",
  );
  return manifest(data.tune);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2),
      options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]?.startsWith("--") ? args[i].slice(2) : "";
      if (
        ![
          "seed",
          "seed-file",
          "customers",
          "days",
          "tune-dir",
          "private-dir",
        ].includes(key) ||
        key in options ||
        !args[i + 1] ||
        args[i + 1].startsWith("--")
      )
        throw new Error("invalid split argument");
      options[key] = args[i + 1];
    }
    for (const key of ["customers", "days"])
      if (key in options) {
        if (!/^\d+$/.test(options[key]))
          throw new Error("invalid integer argument");
        options[key] = Number(options[key]);
      }
    const {
      "tune-dir": tuneDir,
      "private-dir": privateDir,
      "seed-file": seedFile,
      ...params
    } = options;
    if (seedFile !== undefined) {
      // A secret seed comes from a file kept outside the checkout, never from argv.
      if ("seed" in params) throw new Error("seed and seed-file are exclusive");
      params.seed = readSeedFile(seedFile, { checkoutGuard: true });
    }
    if (!tuneDir) throw new Error("tune-dir is required");
    const data = generateSplitDataset(params);
    const report = writeSplit(data, { tuneDir, privateDir });
    process.stdout.write(
      JSON.stringify({
        ...report,
        holdoutCustomers: data.holdout.simulation.customers.length,
        holdoutPersisted: privateDir !== undefined,
      }) + "\n",
    );
  } catch {
    // Paths can name a private store; do not echo arguments or generator internals on failure.
    process.stderr.write(
      "Split failed: check arguments, new output directories and private path policy.\n",
    );
    process.exitCode = 1;
  }
}
