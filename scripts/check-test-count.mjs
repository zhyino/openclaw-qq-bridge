/**
 * Test-count guard — catch the "green run that skipped files" failure mode.
 *
 * Vitest exits 0 even when a worker dies during module loading (on Windows the
 * SSR cache write can hit `EPERM`). The run then reports fewer files than exist
 * on disk and still says "passed". This script compares the two numbers, so a
 * partially collected run is a hard failure instead of a false green.
 *
 * Usage (after a run with `--reporter=json --outputFile=.vitest-report.json`):
 *   node scripts/check-test-count.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPORT = ".vitest-report.json";

function collect(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, acc);
    else if (entry.name.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

const onDisk = collect("test").sort();

let report;
try {
  report = JSON.parse(readFileSync(REPORT, "utf8"));
} catch {
  console.error(`check-test-count: cannot read ${REPORT}; run vitest with --reporter=json --outputFile=${REPORT}`);
  process.exit(1);
}

const ran = report.testResults.map((t) => t.name.replace(/\\/g, "/")).sort();
const basename = (p) => p.split(/[\\/]/).pop();

const ranNames = new Set(ran.map(basename));
const missing = onDisk.filter((f) => !ranNames.has(basename(f)));

console.log(`check-test-count: ${ran.length} ran, ${onDisk.length} on disk`);

if (missing.length > 0) {
  console.error(`\nFAIL — these test files were never executed:`);
  for (const f of missing) console.error(`  - ${f}`);
  console.error(
    `\nA run that silently drops files reports "passed" and exits 0.\n` +
      `Check for worker crashes (unhandled errors) above, then re-run.`,
  );
  process.exit(1);
}

const skippedFiles = report.testResults.filter((t) => t.assertionResults?.every((a) => a.status === "pending" || a.status === "skipped") && (t.assertionResults?.length ?? 0) > 0);
if (skippedFiles.length > 0) {
  console.warn(`  note: ${skippedFiles.length} file(s) ran with every case skipped (platform guards)`);
}

console.log("  OK — every test file executed");
