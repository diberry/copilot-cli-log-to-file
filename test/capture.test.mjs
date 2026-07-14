/**
 * test/capture.test.mjs
 *
 * Tests for new capture toggles, env overrides, and YAML enrichment.
 * Run with:  node test/capture.test.mjs
 */

import {
  loadConfig,
  buildFileContent,
} from "../.github/extensions/copilot-cli-log-to-file/lib/format.mjs";

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import jsyaml from "js-yaml";

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

// ─── Capture toggles defaults ─────────────────────────────────────────────────
console.error("\nCapture toggles defaults:");

{
  const tmp = mkdtempSync(join(tmpdir(), "clt-test-"));
  try {
    const cfg = loadConfig(tmp);
    assert("defaults: attachments off", cfg.capture.attachments, false);
    assert("defaults: reasoning off", cfg.capture.reasoning, false);
    assert("defaults: toolCalls off", cfg.capture.toolCalls, false);
    assert("defaults: toolResults off", cfg.capture.toolResults, false);
    assert("defaults: usage off", cfg.capture.usage, false);
    assert("defaults: model off", cfg.capture.model, false);
    assert("defaults: skills off", cfg.capture.skills, false);
    assert("defaults: subagents off", cfg.capture.subagents, false);
    assert("defaults: permissions off", cfg.capture.permissions, false);
    assert("defaults: errors off", cfg.capture.errors, false);
    assert("defaults: lifecycle off", cfg.capture.lifecycle, false);
    assert("defaults: turns off", cfg.capture.turns, false);
    assert("defaults: schedules off", cfg.capture.schedules, false);
    assert("defaults: notifications off", cfg.capture.notifications, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── Capture toggles from config.json ─────────────────────────────────────────
console.error("\nCapture toggles from config.json:");

{
  const tmp = mkdtempSync(join(tmpdir(), "clt-test-"));
  try {
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({
        capture: {
          attachments: true,
          reasoning: true,
          toolCalls: true,
          usage: true,
        },
      }),
      "utf8"
    );
    const cfg = loadConfig(tmp);
    assert("config.json: attachments on", cfg.capture.attachments, true);
    assert("config.json: reasoning on", cfg.capture.reasoning, true);
    assert("config.json: toolCalls on", cfg.capture.toolCalls, true);
    assert("config.json: usage on", cfg.capture.usage, true);
    assert("config.json: model still off", cfg.capture.model, false);
    assert("config.json: skills still off", cfg.capture.skills, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── Capture toggles from env vars ────────────────────────────────────────────
console.error("\nCapture toggles from env vars:");

{
  const tmp = mkdtempSync(join(tmpdir(), "clt-test-"));
  try {
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({
        capture: {
          attachments: false,
          reasoning: false,
        },
      }),
      "utf8"
    );
    process.env.COPILOT_LOG_CAPTURE_ATTACHMENTS = "true";
    process.env.COPILOT_LOG_CAPTURE_REASONING = "true";
    process.env.COPILOT_LOG_CAPTURE_TOOLCALLS = "true";
    const cfg = loadConfig(tmp);
    assert("env: attachments wins over config.json", cfg.capture.attachments, true);
    assert("env: reasoning wins over config.json", cfg.capture.reasoning, true);
    assert("env: toolCalls set by env", cfg.capture.toolCalls, true);
    delete process.env.COPILOT_LOG_CAPTURE_ATTACHMENTS;
    delete process.env.COPILOT_LOG_CAPTURE_REASONING;
    delete process.env.COPILOT_LOG_CAPTURE_TOOLCALLS;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── Master CAPTURE_ALL override ──────────────────────────────────────────────
console.error("\nMaster CAPTURE_ALL override:");

{
  const tmp = mkdtempSync(join(tmpdir(), "clt-test-"));
  try {
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({
        capture: {
          attachments: false,
        },
      }),
      "utf8"
    );
    process.env.COPILOT_LOG_CAPTURE_ALL = "true";
    const cfg = loadConfig(tmp);
    assert("CAPTURE_ALL: attachments on", cfg.capture.attachments, true);
    assert("CAPTURE_ALL: reasoning on", cfg.capture.reasoning, true);
    assert("CAPTURE_ALL: toolCalls on", cfg.capture.toolCalls, true);
    assert("CAPTURE_ALL: usage on", cfg.capture.usage, true);
    assert("CAPTURE_ALL: model on", cfg.capture.model, true);
    assert("CAPTURE_ALL: skills on", cfg.capture.skills, true);
    assert("CAPTURE_ALL: subagents on", cfg.capture.subagents, true);
    assert("CAPTURE_ALL: permissions on", cfg.capture.permissions, true);
    assert("CAPTURE_ALL: errors on", cfg.capture.errors, true);
    assert("CAPTURE_ALL: lifecycle on", cfg.capture.lifecycle, true);
    assert("CAPTURE_ALL: turns on", cfg.capture.turns, true);
    assert("CAPTURE_ALL: schedules on", cfg.capture.schedules, true);
    assert("CAPTURE_ALL: notifications on", cfg.capture.notifications, true);
    delete process.env.COPILOT_LOG_CAPTURE_ALL;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── buildFileContent with captured data ──────────────────────────────────────
console.error("\nbuildFileContent with captured data:");

const ts = new Date("2026-07-14T10:00:00.000Z");
const baseData = {
  timestamp: ts,
  sessionId: "test1234",
  prompt: "Test prompt",
  content: "Test response",
  allMessages: [],
  capturedData: {
    attachments: [{ type: "file", path: "/test/file.txt", displayName: "file.txt" }],
    reasoning: [{ content: "Thinking about the problem..." }],
    tools: [
      {
        toolCallId: "call_1",
        toolName: "grep",
        arguments: '{"pattern":"test"}',
        success: true,
        result: "Found 3 matches",
      },
    ],
    usage: [{ model: "gpt-5", inputTokens: 100, outputTokens: 50 }],
    model: [],
    skills: [],
    subagents: [],
    permissions: [],
    errors: [],
    lifecycle: [],
    turns: [],
    schedules: [],
    notifications: [],
  },
};

// Conservative default: nothing extra emitted when all toggles off
{
  const cfg = { capture: { attachments: false, reasoning: false, toolCalls: false, toolResults: false, usage: false, model: false, skills: false, subagents: false, permissions: false, errors: false, lifecycle: false, turns: false, schedules: false, notifications: false } };
  const out = buildFileContent(baseData, "yaml", false, cfg);
  assertContains("conservative: timestamp present", out, "timestamp:");
  assertContains("conservative: prompt present", out, "prompt:");
  assertContains("conservative: response present", out, "response:");
  assertNotContains("conservative: no attachments", out, "attachments:");
  assertNotContains("conservative: no reasoning", out, "reasoning:");
  assertNotContains("conservative: no tools", out, "tools:");
  assertNotContains("conservative: no usage", out, "usage:");
}

// With attachments enabled
{
  const cfg = { capture: { attachments: true, reasoning: false, toolCalls: false, toolResults: false, usage: false, model: false, skills: false, subagents: false, permissions: false, errors: false, lifecycle: false, turns: false, schedules: false, notifications: false } };
  const out = buildFileContent(baseData, "yaml", false, cfg);
  assertContains("attachments on: attachments section present", out, "attachments:");
  assertContains("attachments on: file path present", out, "/test/file.txt");
  assertNotContains("attachments on: no reasoning", out, "reasoning:");
  assertNotContains("attachments on: no tools", out, "tools:");
}

// With reasoning enabled
{
  const cfg = { capture: { attachments: false, reasoning: true, toolCalls: false, toolResults: false, usage: false, model: false, skills: false, subagents: false, permissions: false, errors: false, lifecycle: false, turns: false, schedules: false, notifications: false } };
  const out = buildFileContent(baseData, "yaml", false, cfg);
  assertContains("reasoning on: reasoning section present", out, "reasoning:");
  assertContains("reasoning on: reasoning content present", out, "Thinking about the problem");
  assertNotContains("reasoning on: no attachments", out, "attachments:");
}

// With toolCalls and toolResults enabled
{
  const cfg = { capture: { attachments: false, reasoning: false, toolCalls: true, toolResults: true, usage: false, model: false, skills: false, subagents: false, permissions: false, errors: false, lifecycle: false, turns: false, schedules: false, notifications: false } };
  const out = buildFileContent(baseData, "yaml", false, cfg);
  assertContains("tools on: tools section present", out, "tools:");
  assertContains("tools on: toolCallId present", out, "call_1");
  assertContains("tools on: toolName present", out, "grep");
  assertContains("tools on: success present", out, "success:");
  assertContains("tools on: result present", out, "Found 3 matches");
}

// With usage enabled
{
  const cfg = { capture: { attachments: false, reasoning: false, toolCalls: false, toolResults: false, usage: true, model: false, skills: false, subagents: false, permissions: false, errors: false, lifecycle: false, turns: false, schedules: false, notifications: false } };
  const out = buildFileContent(baseData, "yaml", false, cfg);
  assertContains("usage on: usage section present", out, "usage:");
  assertContains("usage on: model present", out, "gpt-5");
  assertContains("usage on: inputTokens present", out, "inputTokens:");
}

// ─── YAML round-trip with captured data ───────────────────────────────────────
console.error("\nYAML round-trip with captured data:");

{
  const cfg = { capture: { attachments: true, reasoning: true, toolCalls: true, toolResults: true, usage: true, model: false, skills: false, subagents: false, permissions: false, errors: false, lifecycle: false, turns: false, schedules: false, notifications: false } };
  const out = buildFileContent(baseData, "yaml", false, cfg);

  try {
    const parsed = jsyaml.load(out);
    assert("round-trip: parsed successfully", typeof parsed, "object");
    assert("round-trip: timestamp", parsed.timestamp, "2026-07-14T10:00:00.000Z");
    assert("round-trip: sessionId", parsed.sessionId, "test1234");
    assert("round-trip: prompt", parsed.prompt, "Test prompt");
    assert("round-trip: response", parsed.response, "Test response");
    assert("round-trip: attachments is array", Array.isArray(parsed.attachments), true);
    assert("round-trip: attachments length", parsed.attachments.length, 1);
    assert("round-trip: attachment type", parsed.attachments[0].type, "file");
    assert("round-trip: reasoning is array", Array.isArray(parsed.reasoning), true);
    assert("round-trip: reasoning length", parsed.reasoning.length, 1);
    assert("round-trip: tools is array", Array.isArray(parsed.tools), true);
    assert("round-trip: tools length", parsed.tools.length, 1);
    assert("round-trip: tool toolCallId", parsed.tools[0].toolCallId, "call_1");
    assert("round-trip: usage is array", Array.isArray(parsed.usage), true);
    assert("round-trip: usage length", parsed.usage.length, 1);
    assert("round-trip: usage model", parsed.usage[0].model, "gpt-5");
  } catch (err) {
    console.error(`  ✗ round-trip: YAML parse failed: ${err.message}`);
    failed++;
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.error(`\n${"─".repeat(50)}`);
console.error(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.error("All tests passed ✓");
}
