#!/usr/bin/env node
/**
 * CI Validation Script for Hivemind SESI
 *
 * Validates project configuration files:
 * - package.json has required fields
 * - .env.example has required variables
 * - Core source files exist
 * - No hardcoded secrets in source
 *
 * Inspired by validation scripts from everything-claude-code.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
let hasErrors = false;

function check(condition, message) {
  if (!condition) {
    console.error(`ERROR: ${message}`);
    hasErrors = true;
  } else {
    console.log(`  ✓ ${message}`);
  }
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function readFileText(relativePath) {
  try {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  } catch {
    return null;
  }
}

// ── Validate package.json ────────────────────────────────────────────────
console.log("\nValidating package.json...");

const pkg = JSON.parse(readFileText("package.json") || "{}");
check(pkg.name, "package.json has name");
check(pkg.version, "package.json has version");
check(pkg.main, "package.json has main entry");
check(pkg.scripts?.start, "package.json has start script");
check(pkg.scripts?.test, "package.json has test script");
check(pkg.engines?.node, "package.json specifies node engine");
check(pkg.license, "package.json has license");

// ── Validate required files ─────────────────────────────────────────────
console.log("\nValidating required files...");

const requiredFiles = [
  "sesi-swarm-server.js",
  "package.json",
  ".env.example",
  ".gitignore",
  "Dockerfile",
  "README.md",
];

for (const file of requiredFiles) {
  check(fileExists(file), `${file} exists`);
}

// ── Validate .env.example ───────────────────────────────────────────────
console.log("\nValidating .env.example...");

const envExample = readFileText(".env.example");
if (envExample) {
  check(envExample.includes("ANTHROPIC_API_KEY"), ".env.example contains ANTHROPIC_API_KEY");
  check(!(/sk-ant-[a-zA-Z0-9]{20,}/.test(envExample)), ".env.example does not contain real API key");
}

// ── Check for hardcoded secrets ─────────────────────────────────────────
console.log("\nScanning for hardcoded secrets...");

const sourceFiles = ["sesi-swarm-server.js", "benchmark.js"];
const secretPatterns = [
  /sk-ant-[a-zA-Z0-9]{20,}/,
  /password\s*=\s*["'][^'"]+["']/i,
  /api_key\s*=\s*["']sk/i,
];

for (const file of sourceFiles) {
  const content = readFileText(file);
  if (!content) continue;

  for (const pattern of secretPatterns) {
    check(!pattern.test(content), `${file} has no hardcoded secrets matching ${pattern.source}`);
  }
}

// ── Validate .gitignore ─────────────────────────────────────────────────
console.log("\nValidating .gitignore...");

const gitignore = readFileText(".gitignore");
if (gitignore) {
  check(gitignore.includes("node_modules"), ".gitignore excludes node_modules");
  check(gitignore.includes(".env"), ".gitignore excludes .env");
}

// ── Result ───────────────────────────────────────────────────────────────
console.log();
if (hasErrors) {
  console.error("Validation FAILED — fix errors above");
  process.exit(1);
} else {
  console.log("All validations passed ✓");
}
