#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."
transcript=docs/features/screenshots/DBS-126/manual-test.txt
code_sha=$(git log -1 --format=%H -- load-tests/fraud-dataset/*.mjs .github/workflows/ci.yml)
git diff --quiet "$code_sha" -- load-tests/fraud-dataset/*.mjs .github/workflows/ci.yml
printf '%s\n' "$code_sha" > "$transcript"
printf 'DBS-126 manual CLI, Git Bash, synthetic data only\n' | tee -a "$transcript"
node --version | tee -a "$transcript"
sha256sum load-tests/fraud-dataset/{generate,generate-fraud,scenarios,inspect-fraud}.mjs | tee -a "$transcript"

run() {
  local expected=$1; shift
  printf '$' | tee -a "$transcript"
  printf ' %q' "$@" | tee -a "$transcript"
  printf '\n' | tee -a "$transcript"
  set +e
  "$@" 2>&1 | tee -a "$transcript"
  local statuses=("${PIPESTATUS[@]}")
  set -e
  printf 'exit=%d expected=%d\n' "${statuses[0]}" "$expected" | tee -a "$transcript"
  [[ ${statuses[0]} == "$expected" && ${statuses[1]} == 0 ]]
}
mark() { printf '\n%s\n' "$1" | tee -a "$transcript"; }
mark M-126-01
run 0 node load-tests/fraud-dataset/generate-fraud.mjs --output load-tests/results/dbs126-a.csv
mark M-126-02
run 0 node load-tests/fraud-dataset/generate-fraud.mjs --output load-tests/results/dbs126-b.csv
for suffix in '' .simulation.json .stats.json; do
  run 0 sha256sum "load-tests/results/dbs126-a.csv$suffix" "load-tests/results/dbs126-b.csv$suffix"
  run 0 cmp "load-tests/results/dbs126-a.csv$suffix" "load-tests/results/dbs126-b.csv$suffix"
done
mark M-126-03
run 0 node load-tests/fraud-dataset/generate-fraud.mjs --seed dbs-fraud-v2 --output load-tests/results/dbs126-c.csv
run 0 sha256sum load-tests/results/dbs126-a.csv load-tests/results/dbs126-c.csv
run 1 cmp load-tests/results/dbs126-a.csv load-tests/results/dbs126-c.csv
mark M-126-04
run 0 node load-tests/fraud-dataset/inspect-fraud.mjs --csv load-tests/results/dbs126-a.csv --simulation load-tests/results/dbs126-a.csv.simulation.json
run 0 node --input-type=module -e '
import {readFileSync} from "node:fs";
import assert from "node:assert/strict";
import {inspectDataset} from "./load-tests/fraud-dataset/inspect-fraud.mjs";
const path="load-tests/results/dbs126-a.csv", csv=readFileSync(path,"utf8");
assert.deepEqual(inspectDataset(csv,JSON.parse(readFileSync(path+".simulation.json","utf8"))),JSON.parse(readFileSync(path+".stats.json","utf8")));
const lines=csv.trimEnd().split("\n"),seen=new Set(); console.log(lines[0]);
for(const line of lines.slice(1)){const row=line.split(",");if(!seen.has(row[11])){seen.add(row[11]);console.log(line);}}
console.log("Independent report matches sidecar; one real row per scenario printed.");'
mark M-126-05
run 1 node load-tests/fraud-dataset/generate-fraud.mjs --customers 999 --output load-tests/results/dbs126-invalid.csv
run 0 node --input-type=module -e 'import{existsSync}from"node:fs"; for(const suffix of ["",".simulation.json",".stats.json"]) if(existsSync("load-tests/results/dbs126-invalid.csv"+suffix)) throw new Error("unexpected invalid artifact");console.log("No invalid artifacts");'
run 0 node load-tests/fraud-dataset/generate-fraud.mjs --customers 1000 --days 30 --output load-tests/results/dbs126-min.csv
mark M-126-06
run 0 node --input-type=module -e 'import{readFileSync,writeFileSync}from"node:fs";const lines=readFileSync("load-tests/results/dbs126-a.csv","utf8").split("\n"),row=lines[1].split(",");row[7]=String(BigInt(row[7])-1n);lines[1]=row.join(",");writeFileSync("load-tests/results/dbs126-broken.csv",lines.join("\n"));console.log("Changed only the copy: first balance snapshot -1 dong");'
run 1 node load-tests/fraud-dataset/inspect-fraud.mjs --csv load-tests/results/dbs126-broken.csv --simulation load-tests/results/dbs126-a.csv.simulation.json
run 0 node load-tests/fraud-dataset/inspect-fraud.mjs --csv load-tests/results/dbs126-a.csv --simulation load-tests/results/dbs126-a.csv.simulation.json
mark M-126-07
run 0 node load-tests/fraud-dataset/generate.mjs --output load-tests/results/dbs126-normal.csv
run 0 node --input-type=module -e 'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";import assert from"node:assert/strict";const hash=createHash("sha256").update(readFileSync("load-tests/results/dbs126-normal.csv")).digest("hex");assert.equal(hash,"60e10c49abe8a6f9377dab29b729eaaf4a0f1d1a11dadfa759d8813aa7a7476f");console.log("NORMAL golden hash unchanged:",hash);'
run 0 node --test load-tests/fraud-dataset/generate.test.mjs
mark "M-126-01 through M-126-07 PASS on final code commit $code_sha."
