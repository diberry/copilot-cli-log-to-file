/**
 * test/yaml.test.mjs
 *
 * Round-trip YAML validity tests for buildFileContent (yaml format).
 * Requires js-yaml as a devDependency.  Run with:
 *   node test/yaml.test.mjs
 *
 * Each adversarial case calls buildFileContent, loads the result with
 * yaml.load(), and asserts that values round-trip correctly.
 *
 * NOTE: |- (strip chomp) removes all trailing newlines.  Test values are
 * constructed without trailing newlines so round-trips are exact.
 */

import yaml from "js-yaml";
import { buildFileContent } from "../.github/extensions/copilot-cli-log-to-file/lib/format.mjs";

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

function assertDeepEqual(description, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.error(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    expected: ${e}`);
    console.error(`    actual:   ${a}`);
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

const BASE_TS = new Date("2026-07-13T11:21:45.000Z");
const BASE_SESSION = "abcdef1234567890";

/**
 * Build yaml output and parse it back via js-yaml.
 */
function roundTrip(prompt, response, allMessages = null) {
  const data = {
    timestamp: BASE_TS,
    sessionId: BASE_SESSION,
    prompt,
    content: response,
    allMessages: allMessages ?? [],
  };
  const includeAllMessages = allMessages !== null && allMessages.length > 0;
  const raw = buildFileContent(data, "yaml", includeAllMessages);
  return { raw, parsed: yaml.load(raw) };
}

// ─── Top-level key presence ───────────────────────────────────────────────────
console.error("\nTop-level key presence:");
{
  const { parsed } = roundTrip("hello", "world");
  assert("has timestamp key", "timestamp" in parsed, true);
  assert("has sessionId key", "sessionId" in parsed, true);
  assert("has prompt key", "prompt" in parsed, true);
  assert("has response key", "response" in parsed, true);
  assert("timestamp value is ISO string", parsed.timestamp, BASE_TS.toISOString());
  assert("sessionId value correct", parsed.sessionId, BASE_SESSION);
}

// ─── Adversarial string: colon-containing line ────────────────────────────────
console.error("\nAdversarial: colon-containing value:");
{
  const v = "key: value and http://x";
  const { parsed } = roundTrip(v, v);
  assert("prompt round-trips with colon", parsed.prompt, v);
  assert("response round-trips with colon", parsed.response, v);
}

// ─── Adversarial: comment-looking line ───────────────────────────────────────
console.error("\nAdversarial: comment-looking line:");
{
  const v = "# not a comment";
  const { parsed } = roundTrip(v, v);
  assert("prompt round-trips hash comment", parsed.prompt, v);
  assert("response round-trips hash comment", parsed.response, v);
}

// ─── Adversarial: YAML doc separator ─────────────────────────────────────────
console.error("\nAdversarial: YAML document separator ---:");
{
  const v = "---";
  const { parsed } = roundTrip(v, v);
  assert("prompt round-trips ---", parsed.prompt, v);
  assert("response round-trips ---", parsed.response, v);
}

// ─── Adversarial: quotes ─────────────────────────────────────────────────────
console.error("\nAdversarial: mixed quotes:");
{
  const v = `she said "hi" and 'bye'`;
  const { parsed } = roundTrip(v, v);
  assert("prompt round-trips quotes", parsed.prompt, v);
  assert("response round-trips quotes", parsed.response, v);
}

// ─── Adversarial: backslash + tab ────────────────────────────────────────────
console.error("\nAdversarial: backslash and tab:");
{
  const v = "path\\to\tfile";
  const { parsed } = roundTrip(v, v);
  assert("prompt round-trips backslash+tab", parsed.prompt, v);
  assert("response round-trips backslash+tab", parsed.response, v);
}

// ─── Adversarial: multi-line with blank line in middle ───────────────────────
console.error("\nAdversarial: multi-line with blank line:");
{
  const v = "first line\n\nsecond line after blank";
  const { parsed } = roundTrip(v, v);
  assert("prompt round-trips multi-line+blank", parsed.prompt, v);
  assert("response round-trips multi-line+blank", parsed.response, v);
}

// ─── Adversarial: trailing spaces on a line ──────────────────────────────────
console.error("\nAdversarial: trailing spaces:");
{
  const v = "line with trailing   ";
  const { parsed } = roundTrip(v, v);
  assert("prompt round-trips trailing spaces", parsed.prompt, v);
  assert("response round-trips trailing spaces", parsed.response, v);
}

// ─── Adversarial: unicode / emoji ────────────────────────────────────────────
console.error("\nAdversarial: unicode and emoji:");
{
  const v = "café 🚀 日本語";
  const { parsed } = roundTrip(v, v);
  assert("prompt round-trips unicode/emoji", parsed.prompt, v);
  assert("response round-trips unicode/emoji", parsed.response, v);
}

// ─── Empty response string ────────────────────────────────────────────────────
console.error("\nEmpty response string:");
{
  const prompt = "hello";
  const response = "";
  const { raw, parsed } = roundTrip(prompt, response);
  assertContains("empty response emitted as double-quoted empty", raw, 'response: ""');
  assert("empty response loads to empty string", parsed.response, "");
}

// ─── Empty prompt string ──────────────────────────────────────────────────────
console.error("\nEmpty prompt string:");
{
  const { raw, parsed } = roundTrip("", "some response");
  assertContains("empty prompt emitted as double-quoted empty", raw, 'prompt: ""');
  assert("empty prompt loads to empty string", parsed.prompt, "");
}

// ─── includeAllMessages=true with 2+ messages ────────────────────────────────
console.error("\nincludeAllMessages with 2+ messages:");
{
  const msgs = [
    "First message with colon: here",
    "Second message\nwith newline",
    `Third has "quotes" and # hash`,
  ];
  const data = {
    timestamp: BASE_TS,
    sessionId: BASE_SESSION,
    prompt: "multi-msg prompt",
    content: msgs[2],
    allMessages: msgs,
  };
  const raw = buildFileContent(data, "yaml", true);
  const parsed = yaml.load(raw);

  assert("messages key present", Array.isArray(parsed.messages), true);
  assert("messages array length", parsed.messages.length, 3);
  assert("message[0] round-trips", parsed.messages[0], msgs[0]);
  assert("message[1] round-trips", parsed.messages[1], msgs[1]);
  assert("message[2] round-trips", parsed.messages[2], msgs[2]);
}

// ─── includeAllMessages=false → no messages key ──────────────────────────────
console.error("\nincludeAllMessages=false:");
{
  const data = {
    timestamp: BASE_TS,
    sessionId: BASE_SESSION,
    prompt: "p",
    content: "r",
    allMessages: ["early", "r"],
  };
  const raw = buildFileContent(data, "yaml", false);
  const parsed = yaml.load(raw);
  assert("messages key absent when includeAllMessages=false", "messages" in parsed, false);
}

// ─── Windows CRLF in content normalizes correctly ────────────────────────────
console.error("\nCRLF normalization:");
{
  const v = "line one\r\nline two\r\nline three";
  const expected = "line one\nline two\nline three";
  const { parsed } = roundTrip(v, v);
  assert("CRLF prompt normalizes to LF", parsed.prompt, expected);
  assert("CRLF response normalizes to LF", parsed.response, expected);
}

// ─── Lone CR normalizes correctly ────────────────────────────────────────────
console.error("\nLone CR normalization:");
{
  const v = "line one\rline two";
  const expected = "line one\nline two";
  const { parsed } = roundTrip(v, v);
  assert("lone CR prompt normalizes to LF", parsed.prompt, expected);
}

// ─── Helper: round-trip a value as a sequence message ────────────────────────
function roundTripMsg(msgValue) {
  const { parsed } = roundTrip("p", "r", [msgValue]);
  return parsed.messages ? parsed.messages[0] : undefined;
}

// ─── Leading-space values ─────────────────────────────────────────────────────
console.error("\nLeading-space values:");
{
  const v1 = " content";
  const { parsed: p1 } = roundTrip(v1, v1);
  assert("prompt single-leading-space round-trips", p1.prompt, v1);
  assert("response single-leading-space round-trips", p1.response, v1);
  assert("message single-leading-space round-trips", roundTripMsg(v1), v1);

  const v2 = "  code";
  const { parsed: p2 } = roundTrip(v2, v2);
  assert("prompt two-leading-spaces round-trips", p2.prompt, v2);
  assert("response two-leading-spaces round-trips", p2.response, v2);
  assert("message two-leading-spaces round-trips", roundTripMsg(v2), v2);
}

// ─── Indented code block ──────────────────────────────────────────────────────
console.error("\nIndented code block:");
{
  const v = "    if x:\n        y";
  const { parsed } = roundTrip(v, v);
  assert("prompt indented-code round-trips", parsed.prompt, v);
  assert("response indented-code round-trips", parsed.response, v);
  assert("message indented-code round-trips", roundTripMsg(v), v);
}

// ─── Interior indentation (first line not indented) ──────────────────────────
console.error("\nInterior indentation:");
{
  const v = "line1\n  line2 indented\nline3";
  const { parsed } = roundTrip(v, v);
  assert("prompt interior-indent round-trips", parsed.prompt, v);
  assert("response interior-indent round-trips", parsed.response, v);
  assert("message interior-indent round-trips", roundTripMsg(v), v);
}

// ─── Whitespace-only values (double-quoted fallback) ─────────────────────────
console.error("\nWhitespace-only values:");
{
  const v1 = "     ";
  const { parsed: p1 } = roundTrip(v1, v1);
  assert("prompt spaces-only round-trips", p1.prompt, v1);
  assert("response spaces-only round-trips", p1.response, v1);
  assert("message spaces-only round-trips", roundTripMsg(v1), v1);

  const v2 = "\t\t";
  const { parsed: p2 } = roundTrip(v2, v2);
  assert("prompt tabs-only round-trips", p2.prompt, v2);
  assert("response tabs-only round-trips", p2.response, v2);
  assert("message tabs-only round-trips", roundTripMsg(v2), v2);
}

// ─── Newline-only values (double-quoted fallback) ─────────────────────────────
console.error("\nNewline-only values:");
{
  const v1 = "\n";
  const { parsed: p1 } = roundTrip(v1, v1);
  assert("prompt single-newline round-trips", p1.prompt, v1);
  assert("response single-newline round-trips", p1.response, v1);
  assert("message single-newline round-trips", roundTripMsg(v1), v1);

  const v2 = "\n\n";
  const { parsed: p2 } = roundTrip(v2, v2);
  assert("prompt double-newline round-trips", p2.prompt, v2);
  assert("response double-newline round-trips", p2.response, v2);
  assert("message double-newline round-trips", roundTripMsg(v2), v2);
}

// ─── Trailing spaces on the last/only line ────────────────────────────────────
console.error("\nTrailing spaces on last line:");
{
  const v = "trailing space line ends here   ";
  const { parsed } = roundTrip(v, v);
  assert("prompt trailing-spaces-last-line round-trips", parsed.prompt, v);
  assert("response trailing-spaces-last-line round-trips", parsed.response, v);
  assert("message trailing-spaces-last-line round-trips", roundTripMsg(v), v);
}

// ─── Trailing newline preservation ───────────────────────────────────────────
console.error("\nTrailing newline preservation:");
{
  const v1 = "ends with newline\n";
  const { parsed: p1 } = roundTrip(v1, v1);
  assert("prompt one-trailing-newline preserved", p1.prompt, v1);
  assert("response one-trailing-newline preserved", p1.response, v1);
  assert("message one-trailing-newline preserved", roundTripMsg(v1), v1);

  const v2 = "ends with two newlines\n\n";
  const { parsed: p2 } = roundTrip(v2, v2);
  assert("prompt two-trailing-newlines preserved", p2.prompt, v2);
  assert("response two-trailing-newlines preserved", p2.response, v2);
  assert("message two-trailing-newlines preserved", roundTripMsg(v2), v2);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.error(`\n${"─".repeat(50)}`);
console.error(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.error("All tests passed ✓");
}
