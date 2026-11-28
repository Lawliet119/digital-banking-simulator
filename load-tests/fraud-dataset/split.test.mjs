import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateSplitDataset, readSeedFile, writeSplit } from "./split.mjs";
import { inspectDataset } from "./inspect-fraud.mjs";
import { verifyTune } from "../verify-tune.mjs";

const data = generateSplitDataset();
const customers = (part) =>
  new Set(part.simulation.customers.map((c) => c.customerId));
const CLI_FILE = fileURLToPath(new URL("./split.mjs", import.meta.url));
const CLI_DIR = dirname(CLI_FILE);
const VERIFY_FILE = fileURLToPath(
  new URL("../verify-tune.mjs", import.meta.url),
);
const cli = (...args) =>
  spawnSync(process.execPath, [CLI_FILE, ...args], { encoding: "utf8" });
const temporary = (fn) => {
  const root = mkdtempSync(join(tmpdir(), "dbs127-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("TC-127-08 I/O failure has no successful package or success output", () =>
  temporary((root) => {
    const blocker = join(root, "file-parent");
    writeFileSync(blocker, "sentinel");
    const out = join(blocker, "tune");
    const result = cli("--tune-dir", out);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(blocker, "utf8"), "sentinel");
  }));

test("TC-127-01 same seed produces byte-identical independent cohorts", () => {
  assert.deepEqual(generateSplitDataset(), data);
});
test("TC-127-02/03/04 both endpoints, accounts and all registry customers are disjoint 2800/1200", () => {
  const t = customers(data.tune),
    h = customers(data.holdout);
  assert.equal(t.size, 2800);
  assert.equal(h.size, 1200);
  assert.equal([...t].filter((x) => h.has(x)).length, 0);
  const tuneAccounts = new Set(
    data.tune.simulation.accounts.map((a) => a.accountId),
  );
  assert.equal(
    data.holdout.simulation.accounts.filter((a) =>
      tuneAccounts.has(a.accountId),
    ).length,
    0,
  );
  const txIds = new Set();
  for (const part of [data.tune, data.holdout]) {
    const ids = customers(part);
    for (const line of part.csv.trimEnd().split("\n").slice(1)) {
      const r = line.split(",");
      assert.ok(ids.has(r[4]) && ids.has(r[5]));
      assert.ok(!txIds.has(r[0]));
      txIds.add(r[0]);
    }
    assert.deepEqual(inspectDataset(part.csv, part.simulation), part.stats);
    const checked = verifyTune(part.csv);
    assert.equal(checked.transactions, part.stats.transactions);
    assert.ok(part.stats.fraudRate >= 0.008 && part.stats.fraudRate <= 0.012);
  }
});
test("TC-127-05 invalid options reject before generation; odd totals round tune down", () => {
  for (const options of [
    { customers: 3333 },
    { customers: 100001 },
    { customers: 4000.5 },
    { customers: "4000" },
    { seed: "" },
    { seed: "x".repeat(129) },
    { days: 29 },
    { days: 91 },
    { days: NaN },
  ]) {
    assert.throws(() => generateSplitDataset(options));
  }
  const odd = generateSplitDataset({
    customers: 3335,
    seed: "dbs127-boundary",
    days: 30,
  });
  assert.equal(odd.tune.simulation.customers.length, 2334);
  assert.equal(odd.holdout.simulation.customers.length, 1001);
});
test("TC-127-06 tune-only writes no holdout/source/seed/simulation artifact", () =>
  temporary((root) => {
    const target = join(root, "tune");
    writeSplit(data, { tuneDir: target });
    assert.equal(readFileSync(join(target, "tune.csv"), "utf8"), data.tune.csv);
    const manifest = JSON.parse(readFileSync(join(target, "manifest.json")));
    assert.deepEqual(Object.keys(manifest).sort(), [
      "columns",
      "customers",
      "sha256",
      "transactions",
      "version",
    ]);
    assert.equal(manifest.customers, 2800);
    assert.ok(!existsSync(join(root, "holdout")));
  }));
test("TC-127-07 nested, checkout, existing and symlinked private outputs fail before writing", () =>
  temporary((root) => {
    const tune = join(root, "tune");
    for (const privateDir of [
      resolve("load-tests/results/private"),
      join(tune, "private"),
      root,
    ]) {
      assert.throws(() => writeSplit(data, { tuneDir: tune, privateDir }));
      assert.ok(!existsSync(tune));
    }
    mkdirSync(join(root, "existing"));
    assert.throws(() => writeSplit(data, { tuneDir: join(root, "existing") }));
    symlinkSync(
      resolve("."),
      join(root, "repo-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(() =>
      writeSplit(data, {
        tuneDir: tune,
        privateDir: join(root, "repo-link", "private"),
      }),
    );
    assert.ok(!existsSync(tune));
  }));
test("TC-127-07 explicit private output uses separate files and rejects duplicate output without overwrite", () =>
  temporary((root) => {
    // Transport fixture only: never persist the evaluation holdout during tests.
    const fixture = {
      tune: {
        csv: data.tune.csv.split("\n").slice(0, 2).join("\n") + "\n",
        simulation: { customers: [{}] },
        stats: { transactions: 1 },
      },
      holdout: {
        csv: "synthetic-private-fixture\n",
        simulation: { customers: [{}] },
        stats: { transactions: 1 },
      },
    };
    const tuneDir = join(root, "tune"),
      privateDir = join(root, "sealed");
    writeSplit(fixture, { tuneDir, privateDir });
    assert.equal(
      readFileSync(join(privateDir, "holdout.csv"), "utf8"),
      fixture.holdout.csv,
    );
    assert.ok(!existsSync(join(tuneDir, "holdout.csv")));
    assert.throws(() => writeSplit(fixture, { tuneDir, privateDir }));
  }));
test("TC-127-08 CLI rejects malformed and duplicate args without creating output", () =>
  temporary((root) => {
    const out = join(root, "absent");
    for (const args of [
      ["--wat", "x"],
      ["--customers", "4000.1"],
      ["--seed", "a", "--seed", "b"],
      ["--days", "29"],
      ["--tune-dir", out, "--customers", "2e3"],
    ]) {
      const result = cli(...args);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(!existsSync(out));
      assert.ok(!result.stdout.includes('"sha256"'));
    }
  }));
test("TC-127-09 CLI hash and tune bytes stable across paths/timezones; independent offline verifier", () =>
  temporary((root) => {
    for (const [i, TZ] of ["UTC", "Asia/Ho_Chi_Minh"].entries()) {
      const output = join(root, String(i));
      const result = spawnSync(
        process.execPath,
        [CLI_FILE, "--tune-dir", output],
        { encoding: "utf8", env: { ...process.env, TZ } },
      );
      assert.equal(result.status, 0, result.stderr);
      const csv = readFileSync(join(output, "tune.csv"), "utf8");
      assert.equal(csv, data.tune.csv);
      const verify = spawnSync(
        process.execPath,
        [VERIFY_FILE, join(output, "tune.csv")],
        { encoding: "utf8" },
      );
      assert.equal(verify.status, 0, verify.stderr);
      assert.equal(
        JSON.parse(verify.stdout).transactions,
        data.tune.stats.transactions,
      );
    }
  }));
test("TC-127-08 CSV-only verifier rejects malformed headers, IDs, precision, timestamps and labels", () => {
  const lines = data.tune.csv.split("\n"),
    header = lines[0],
    row = lines[1].split(",");
  for (const [col, value] of [
    [0, "bad"],
    [4, "bad"],
    [6, "1e10"],
    [6, "01"],
    [1, "2026-01-01"],
    [10, "true"],
    [11, "UNKNOWN"],
  ]) {
    const r = [...row];
    r[col] = value;
    assert.throws(() => verifyTune(header + "\n" + r.join(",") + "\n"));
  }
  const huge = [...row];
  huge[6] = "9007199254740993";
  huge[7] = "9007199254740994";
  assert.equal(
    verifyTune(header + "\n" + huge.join(",") + "\n").transactions,
    1,
  );
});

// BL-171: a secret holdout seed is read from a file kept outside the checkout, never from argv.
test("TC-171-01 readSeedFile drops exactly one trailing newline and rejects unsafe seeds", () =>
  temporary((root) => {
    const at = (name, text) => {
      const file = join(root, name);
      writeFileSync(file, text);
      return file;
    };
    assert.equal(readSeedFile(at("lf", "seed-1\n")), "seed-1");
    assert.equal(readSeedFile(at("crlf", "seed-1\r\n")), "seed-1");
    assert.equal(readSeedFile(at("bare", "seed-1")), "seed-1");
    for (const [name, text] of [
      ["empty", ""],
      ["newline-only", "\n"],
      ["two-newlines", "seed-1\n\n"],
      ["bom", "﻿seed-1"],
      ["control", "seed\u0007-1"],
      ["padded", " seed-1"],
      ["long", "x".repeat(129)],
    ]) {
      assert.throws(() => readSeedFile(at(name, text)), name);
    }
    assert.equal(readSeedFile(at("max", "x".repeat(128))), "x".repeat(128));
  }));
test("TC-171-02 a seed file inside a checkout is refused when the guard is on", () => {
  const inside = mkdtempSync(join(CLI_DIR, ".seed-guard-"));
  try {
    const file = join(inside, "seed.txt");
    writeFileSync(file, "secret-seed\n");
    assert.throws(() => readSeedFile(file, { checkoutGuard: true }));
    assert.equal(readSeedFile(file), "secret-seed");
  } finally {
    rmSync(inside, { recursive: true, force: true });
  }
});
test("TC-171-03 CLI --seed-file generates what the same seed given inline would, and never echoes it", () =>
  temporary((root) => {
    const seed = "secret-holdout-seed-for-test";
    const seedFile = join(root, "seed.txt");
    writeFileSync(seedFile, seed + "\n");
    const tuneDir = join(root, "tune"),
      privateDir = join(root, "sealed");
    const result = cli(
      "--seed-file",
      seedFile,
      "--tune-dir",
      tuneDir,
      "--private-dir",
      privateDir,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(seed) && !result.stderr.includes(seed));
    const expected = generateSplitDataset({ seed });
    assert.equal(
      readFileSync(join(tuneDir, "tune.csv"), "utf8"),
      expected.tune.csv,
    );
    assert.equal(
      readFileSync(join(privateDir, "holdout.csv"), "utf8"),
      expected.holdout.csv,
    );
    // Another seed is another holdout: the file really is what drives the generator.
    assert.notEqual(expected.holdout.csv, data.holdout.csv);
  }));
test("TC-171-04 CLI refuses --seed with --seed-file, a bad seed file and a seed file in a checkout", () =>
  temporary((root) => {
    const good = join(root, "good.txt");
    writeFileSync(good, "secret-seed\n");
    const bad = join(root, "bad.txt");
    writeFileSync(bad, "");
    const inside = mkdtempSync(join(CLI_DIR, ".seed-guard-"));
    try {
      const tracked = join(inside, "seed.txt");
      writeFileSync(tracked, "secret-seed\n");
      for (const args of [
        ["--seed", "a", "--seed-file", good],
        ["--seed-file", bad],
        ["--seed-file", join(root, "missing.txt")],
        ["--seed-file", tracked],
        ["--seed-file", good, "--seed-file", good],
      ]) {
        const out = join(root, `out-${Math.random().toString(36).slice(2)}`);
        const result = cli(...args, "--tune-dir", out);
        assert.equal(result.status, 1, args.join(" "));
        assert.ok(!existsSync(out), args.join(" "));
        assert.ok(!result.stdout.includes('"sha256"'));
        assert.ok(!result.stderr.includes("secret-seed"));
      }
    } finally {
      rmSync(inside, { recursive: true, force: true });
    }
  }));
