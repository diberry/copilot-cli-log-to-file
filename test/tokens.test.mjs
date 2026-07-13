/**
 * test/tokens.test.mjs
 *
 * Standalone Node.js test for pure helpers in lib/format.mjs.
 * Run with:  node test/tokens.test.mjs
 *
 * No test runner needed — plain assertions with process.exit(1) on failure.
 */

import {
  sanitizePrompt,
  formatTimestamp,
  substituteTokens,
  sanitizeFilename,
  resolveCollision,
} from "../.github/extensions/copilot-cli-log-to-file/lib/format.mjs";

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

// ─── sanitizePrompt ───────────────────────────────────────────────────────────
console.error("\nsanitizePrompt:");

assert(
  "truncates to 30 chars",
  sanitizePrompt("Hello world this is a very long prompt that should be truncated", 30).length <= 30,
  true
);

assert(
  "collapses whitespace",
  sanitizePrompt("hello   world", 30),
  "hello-world"
);

assert(
  "strips illegal chars",
  sanitizePrompt("hello! world? foo<bar>", 80),
  "hello-world-foobar"
);

assert(
  "empty prompt returns no-prompt",
  sanitizePrompt("", 30),
  "no-prompt"
);

assert(
  "whitespace-only prompt returns no-prompt",
  sanitizePrompt("   ", 30),
  "no-prompt"
);

assert(
  "lowercases result",
  sanitizePrompt("Hello World", 30),
  "hello-world"
);

assert(
  "prompt30 truncation at 30",
  sanitizePrompt("abcdefghijklmnopqrstuvwxyz12345678", 30).length <= 30,
  true
);

// ─── formatTimestamp ─────────────────────────────────────────────────────────
console.error("\nformatTimestamp:");

const ts = new Date("2026-07-13T11:21:45.000Z");
const formatted = formatTimestamp(ts);

assert(
  "replaces colons with dashes",
  formatted.includes(":"),
  false
);

assertContains(
  "contains the date part",
  formatted,
  "2026-07-13"
);

assert(
  "drops milliseconds",
  formatted.includes(".000"),
  false
);

// ─── substituteTokens ────────────────────────────────────────────────────────
console.error("\nsubstituteTokens:");

const ctx = {
  timestamp: new Date("2026-07-13T11:21:45.000Z"),
  prompt: "List all my files",
  sessionId: "abcdef1234567890",
};

const result1 = substituteTokens("{timestamp}-{prompt30}.md", ctx);
assertContains("timestamp token replaced", result1, "2026-07-13");
assertContains("prompt30 token replaced", result1, "list-all-my-files");

const result2 = substituteTokens("{sessionId}", ctx);
assert("sessionId is 8 chars", result2, "abcdef12");

const result3 = substituteTokens("{promptSlug}", { ...ctx, prompt: "What is the meaning of life?" });
assertContains("promptSlug longer than prompt30", result3, "what-is-the-meaning-of-life");

// ─── sanitizeFilename ────────────────────────────────────────────────────────
console.error("\nsanitizeFilename:");

assert(
  "strips colon from filename",
  sanitizeFilename("foo:bar.md"),
  "foobar.md"
);

assert(
  "strips backslash",
  sanitizeFilename("foo\\bar.md"),
  "foobar.md"
);

assert(
  "strips forward slash",
  sanitizeFilename("foo/bar.md"),
  "foobar.md"
);

assert(
  "strips angle brackets",
  sanitizeFilename("<foo>.md"),
  "foo.md"
);

const longName = "a".repeat(200) + ".md";
assert(
  "caps filename at 180 chars",
  sanitizeFilename(longName).length <= 180,
  true
);

// ─── resolveCollision ────────────────────────────────────────────────────────
console.error("\nresolveCollision:");

// Simulate no existing files
assert(
  "returns original name when no collision",
  resolveCollision("/some/dir", "output.md", () => false),
  "output.md"
);

// Simulate first file exists
assert(
  "returns -2 suffix on first collision",
  resolveCollision("/some/dir", "output.md", (p) => p.endsWith("output.md")),
  "output-2.md"
);

// Simulate first two exist
assert(
  "returns -3 suffix on second collision",
  resolveCollision(
    "/some/dir",
    "output.md",
    (p) => p.endsWith("output.md") || p.endsWith("output-2.md")
  ),
  "output-3.md"
);

// ─── Summary ─────────────────────────────────────────────────────────────────
console.error(`\n${"─".repeat(50)}`);
console.error(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.error("All tests passed ✓");
}
