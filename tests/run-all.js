#!/usr/bin/env node
/**
 * Hivemind SESI Test Runner
 *
 * Discovers and runs all *.test.js files under tests/
 * Inspired by the test runner from everything-claude-code.
 *
 * Usage: node tests/run-all.js
 */

import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function discoverTestFiles(dir, baseDir = dir, acc = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(baseDir, full);
    if (e.isDirectory()) {
      discoverTestFiles(full, baseDir, acc);
    } else if (e.isFile() && e.name.endsWith(".test.js")) {
      acc.push(rel);
    }
  }
  return acc.sort();
}

const testFiles = discoverTestFiles(__dirname);
const BOX_W = 58;
const boxLine = s => `║${s.padEnd(BOX_W)}║`;

console.log("╔" + "═".repeat(BOX_W) + "╗");
console.log(boxLine("           Hivemind SESI — Test Suite"));
console.log("╚" + "═".repeat(BOX_W) + "╝");
console.log();

let totalPassed = 0;
let totalFailed = 0;

for (const testFile of testFiles) {
  const testPath = path.join(__dirname, testFile);

  if (!fs.existsSync(testPath)) {
    console.log(`⚠ Skipping ${testFile} (file not found)`);
    continue;
  }

  console.log(`\n━━━ Running ${testFile} ━━━`);

  const result = spawnSync("node", [testPath], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";

  if (stdout) console.log(stdout);
  if (stderr) console.log(stderr);

  const combined = stdout + stderr;
  const passedMatch = combined.match(/Passed:\s*(\d+)/);
  const failedMatch = combined.match(/Failed:\s*(\d+)/);

  if (passedMatch) totalPassed += parseInt(passedMatch[1], 10);
  if (failedMatch) totalFailed += parseInt(failedMatch[1], 10);

  if (result.error) {
    console.log(`✗ ${testFile} failed to start: ${result.error.message}`);
    totalFailed += failedMatch ? 0 : 1;
    continue;
  }

  if (result.status !== 0) {
    console.log(`✗ ${testFile} exited with status ${result.status}`);
    totalFailed += failedMatch ? 0 : 1;
  }
}

const totalTests = totalPassed + totalFailed;

console.log("\n╔" + "═".repeat(BOX_W) + "╗");
console.log(boxLine("                     Final Results"));
console.log("╠" + "═".repeat(BOX_W) + "╣");
console.log(boxLine(`  Total Tests: ${String(totalTests).padStart(4)}`));
console.log(boxLine(`  Passed:      ${String(totalPassed).padStart(4)}  ✓`));
console.log(boxLine(`  Failed:      ${String(totalFailed).padStart(4)}  ${totalFailed > 0 ? "✗" : " "}`));
console.log("╚" + "═".repeat(BOX_W) + "╝");

process.exit(totalFailed > 0 ? 1 : 0);
