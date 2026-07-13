/**
 * test/config.test.mjs
 *
 * Standalone Node.js tests for loadConfig, buildFileContent, and resolveOutputDir
 * from lib/format.mjs.
 * Run with:  node test/config.test.mjs
 *
 * No test runner needed — plain assertions with process.exit(1) on failure.
 */

import {
  loadConfig,
  buildFileContent,
  resolveOutputDir,
} from "../.github/extensions/copilot-cli-log-to-file/lib/format.mjs";

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, isAbsolute } from "path";

let passed = 0;
let failed = 0;

function assert(description, actual, expected) {
  if (actual === expected) {
    console.error(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertContains(description, actual, substring) {
  if (typeof actual === "string" && actual.includes(substring)) {
    console.error(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    expected to contain: ${JSON.stringify(substring)}`);
    console.error(`    actual: ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertNotContains(description, actual, substring) {
  if (typeof actual === "string" && !actual.includes(substring)) {
    console.error(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    expected NOT to contain: ${JSON.stringify(substring)}`);
    console.error(`    actual: ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ─── loadConfig ───────────────────────────────────────────────────────────────
console.error("\nloadConfig:");

// Backup env vars so we can restore them
const envKeys = [
  "COPILOT_LOG_DIR",
  "COPILOT_LOG_FILENAME_PATTERN",
  "COPILOT_LOG_INCLUDE_ALL",
  "COPILOT_LOG_FORMAT",
];
const savedEnv = {};
for (const k of envKeys) {
  savedEnv[k] = process.env[k];
  delete process.env[k];
}

// 1) Returns defaults when no config.json and no env vars
{
  const tmp = mkdtempSync(join(tmpdir(), "clt-test-"));
  try {
    const cfg = loadConfig(tmp);
    assert("defaults: outputDir", cfg.outputDir, "copilot-response-log");
    assert("defaults: filenamePattern", cfg.filenamePattern, "{timestamp}-{prompt30}.yaml");
    assert("defaults: includeAllMessages", cfg.includeAllMessages, false);
    assert("defaults: fileFormat", cfg.fileFormat, "yaml");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 2) config.json values override defaults
{
  const tmp = mkdtempSync(join(tmpdir(), "clt-test-"));
  try {
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({
        outputDir: "my-logs",
        filenamePattern: "{sessionId}.md",
        includeAllMessages: true,
        fileFormat: "txt",
      }),
      "utf8"
    );
    const cfg = loadConfig(tmp);
    assert("config.json: outputDir override", cfg.outputDir, "my-logs");
    assert("config.json: filenamePattern override", cfg.filenamePattern, "{sessionId}.md");
    assert("config.json: includeAllMessages override", cfg.includeAllMessages, true);
    assert("config.json: fileFormat override", cfg.fileFormat, "txt");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 3) env vars override config.json
{
  const tmp = mkdtempSync(join(tmpdir(), "clt-test-"));
  try {
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({
        outputDir: "from-config",
        filenamePattern: "from-config.md",
        includeAllMessages: false,
        fileFormat: "md",
      }),
      "utf8"
    );
    process.env.COPILOT_LOG_DIR = "from-env";
    process.env.COPILOT_LOG_FILENAME_PATTERN = "env-pattern.md";
    process.env.COPILOT_LOG_INCLUDE_ALL = "true";
    process.env.COPILOT_LOG_FORMAT = "txt";
    const cfg = loadConfig(tmp);
    assert("env override: outputDir wins", cfg.outputDir, "from-env");
    assert("env override: filenamePattern wins", cfg.filenamePattern, "env-pattern.md");
    assert("env override: includeAllMessages wins", cfg.includeAllMessages, true);
    assert("env override: fileFormat wins", cfg.fileFormat, "txt");
  } finally {
    delete process.env.COPILOT_LOG_DIR;
    delete process.env.COPILOT_LOG_FILENAME_PATTERN;
    delete process.env.COPILOT_LOG_INCLUDE_ALL;
    delete process.env.COPILOT_LOG_FORMAT;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 4) Malformed config.json → falls back to defaults without throwing
{
  const tmp = mkdtempSync(join(tmpdir(), "clt-test-"));
  try {
    writeFileSync(join(tmp, "config.json"), "{ not valid json }", "utf8");
    let warnCalled = false;
    const cfg = loadConfig(tmp, () => { warnCalled = true; });
    assert("malformed config.json: falls back to defaults", cfg.outputDir, "copilot-response-log");
    assert("malformed config.json: logWarn called", warnCalled, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 5) Invalid fileFormat in config.json → falls back to "yaml"
{
  const tmp = mkdtempSync(join(tmpdir(), "clt-test-"));
  try {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ fileFormat: "json" }), "utf8");
    const cfg = loadConfig(tmp);
    assert("invalid fileFormat falls back to yaml", cfg.fileFormat, "yaml");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 5b) Legacy "md" fileFormat in config.json → maps to "yaml" for back-compat
{
  const tmp = mkdtempSync(join(tmpdir(), "clt-test-"));
  try {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ fileFormat: "md" }), "utf8");
    const cfg = loadConfig(tmp);
    assert("legacy md fileFormat maps to yaml", cfg.fileFormat, "yaml");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 6) COPILOT_LOG_INCLUDE_ALL semantics
{
  const tmp = mkdtempSync(join(tmpdir(), "clt-test-"));
  try {
    process.env.COPILOT_LOG_INCLUDE_ALL = "true";
    assert('INCLUDE_ALL="true" → true', loadConfig(tmp).includeAllMessages, true);

    process.env.COPILOT_LOG_INCLUDE_ALL = "false";
    assert('INCLUDE_ALL="false" → false', loadConfig(tmp).includeAllMessages, false);

    process.env.COPILOT_LOG_INCLUDE_ALL = "1";
    assert('INCLUDE_ALL="1" → false', loadConfig(tmp).includeAllMessages, false);

    process.env.COPILOT_LOG_INCLUDE_ALL = "yes";
    assert('INCLUDE_ALL="yes" → false', loadConfig(tmp).includeAllMessages, false);

    delete process.env.COPILOT_LOG_INCLUDE_ALL;
    assert("INCLUDE_ALL unset → default false", loadConfig(tmp).includeAllMessages, false);
  } finally {
    delete process.env.COPILOT_LOG_INCLUDE_ALL;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Restore original env
for (const k of envKeys) {
  if (savedEnv[k] === undefined) {
    delete process.env[k];
  } else {
    process.env[k] = savedEnv[k];
  }
}

// ─── buildFileContent ─────────────────────────────────────────────────────────
console.error("\nbuildFileContent:");

const ts = new Date("2026-07-13T11:21:45.000Z");
const baseData = {
  timestamp: ts,
  sessionId: "abcdef1234567890",
  prompt: "List all my files",
  content: "Here are your files: foo bar",
  allMessages: [],
};

// yaml format (default, and also what "md" maps to for back-compat)
{
  const out = buildFileContent(baseData, "yaml", false);
  assertContains("yaml: contains timestamp key", out, "timestamp:");
  assertContains("yaml: timestamp is double-quoted", out, '"2026-07-13T11:21:45.000Z"');
  assertContains("yaml: contains sessionId", out, "abcdef1234567890");
  assertContains("yaml: contains prompt block scalar header", out, "prompt: |-");
  assertContains("yaml: contains prompt text", out, "List all my files");
  assertContains("yaml: contains response block scalar header", out, "response: |-");
  assertContains("yaml: contains assistant response", out, "Here are your files: foo bar");
  assertNotContains("yaml: no markdown frontmatter separator", out, "---\n");
}

// back-compat: "md" format → produces yaml output
{
  const out = buildFileContent(baseData, "md", false);
  assertContains("md back-compat: still produces yaml timestamp key", out, "timestamp:");
  assertNotContains("md back-compat: no markdown frontmatter dashes", out, "---\n");
}

// txt format
{
  const out = buildFileContent(baseData, "txt", false);
  assertContains("txt: contains separator line", out, "─".repeat(60));
  assertContains("txt: contains prompt", out, "List all my files");
  assertContains("txt: contains response", out, "Here are your files: foo bar");
  assertNotContains("txt: no YAML frontmatter", out, "---\n");
}

// includeAllMessages=true with multiple messages
{
  const data = {
    ...baseData,
    content: "Final response",
    allMessages: ["First message", "Second message", "Final response"],
  };
  const out = buildFileContent(data, "yaml", true);
  assertContains("includeAll=true: first message appears", out, "First message");
  assertContains("includeAll=true: second message appears", out, "Second message");
  assertContains("includeAll=true: final response appears", out, "Final response");
}

// includeAllMessages=false: only final response
{
  const data = {
    ...baseData,
    content: "Only this",
    allMessages: ["Earlier message", "Only this"],
  };
  const out = buildFileContent(data, "yaml", false);
  assertContains("includeAll=false: final content present", out, "Only this");
  assertNotContains("includeAll=false: no messages key emitted", out, "messages:");
}

// ─── resolveOutputDir ─────────────────────────────────────────────────────────
console.error("\nresolveOutputDir:");

// Absolute path returned unchanged
{
  const absPath = resolve("C:\\absolute\\path\\logs");
  const result = resolveOutputDir(absPath, "C:\\some\\working\\dir");
  assert("absolute path returned as-is", result, absPath);
  assert("result is absolute", isAbsolute(result), true);
}

// Relative path resolved against workingDir
{
  const workingDir = resolve("C:\\projects\\my-project");
  const result = resolveOutputDir("my-logs", workingDir);
  assert("relative path resolved against workingDir", result, resolve(workingDir, "my-logs"));
  assert("resolved path is absolute", isAbsolute(result), true);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.error(`\n${"─".repeat(50)}`);
console.error(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.error("All tests passed ✓");
}
