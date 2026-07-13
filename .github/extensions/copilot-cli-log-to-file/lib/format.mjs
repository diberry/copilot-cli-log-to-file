/**
 * format.mjs — Pure helpers for copilot-cli-log-to-file extension.
 * No SDK imports here so these functions are testable standalone.
 */

import { readFileSync } from "fs";
import { resolve, isAbsolute } from "path";

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  outputDir: "copilot-response-log",
  filenamePattern: "{timestamp}-{prompt30}.yaml",
  includeAllMessages: false,
  fileFormat: "yaml",
};

// ─── Config loading ───────────────────────────────────────────────────────────

/**
 * Normalize a fileFormat value.
 * "yaml" → "yaml", "md" → "yaml" (back-compat), "txt" → "txt", anything else → null.
 * @param {string} val
 * @returns {"yaml"|"txt"|null}
 */
function normalizeFormat(val) {
  if (val === "txt") return "txt";
  if (val === "yaml" || val === "md") return "yaml";
  return null;
}

/**
 * Load config with precedence: defaults < config.json < env vars.
 * @param {string} extensionDir  Absolute path to the extension folder.
 * @param {(msg:string)=>void}  [logWarn]  Optional warning emitter.
 * @returns {typeof DEFAULTS}
 */
export function loadConfig(extensionDir, logWarn = () => {}) {
  let cfg = { ...DEFAULTS };

  // Layer 2: config.json next to extension.mjs
  const configPath = resolve(extensionDir, "config.json");
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.outputDir !== undefined) cfg.outputDir = String(parsed.outputDir);
    if (parsed.filenamePattern !== undefined) cfg.filenamePattern = String(parsed.filenamePattern);
    if (parsed.includeAllMessages !== undefined) cfg.includeAllMessages = Boolean(parsed.includeAllMessages);
    if (parsed.fileFormat !== undefined) {
      const norm = normalizeFormat(parsed.fileFormat);
      if (norm !== null) cfg.fileFormat = norm;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      logWarn(`copilot-cli-log-to-file: config.json parse error — ${err.message}. Using defaults.`);
    }
  }

  // Layer 3: env vars (highest precedence)
  if (process.env.COPILOT_LOG_DIR) cfg.outputDir = process.env.COPILOT_LOG_DIR;
  if (process.env.COPILOT_LOG_FILENAME_PATTERN) cfg.filenamePattern = process.env.COPILOT_LOG_FILENAME_PATTERN;
  if (process.env.COPILOT_LOG_INCLUDE_ALL !== undefined) {
    cfg.includeAllMessages = process.env.COPILOT_LOG_INCLUDE_ALL === "true";
  }
  if (process.env.COPILOT_LOG_FORMAT) {
    const norm = normalizeFormat(process.env.COPILOT_LOG_FORMAT);
    if (norm !== null) cfg.fileFormat = norm;
  }

  return cfg;
}

/**
 * Resolve outputDir: absolute paths used as-is; relative paths resolved from workingDirectory.
 * @param {string} outputDir
 * @param {string} workingDirectory
 * @returns {string}
 */
export function resolveOutputDir(outputDir, workingDirectory) {
  if (isAbsolute(outputDir)) return outputDir;
  return resolve(workingDirectory, outputDir);
}

// ─── Sanitizers ──────────────────────────────────────────────────────────────

/**
 * Sanitize a prompt string into a slug:
 *  - Collapse whitespace to single spaces
 *  - Strip chars not in [A-Za-z0-9 _-]
 *  - Trim, replace spaces with "-", lowercase
 *  - Optionally truncate to maxLen chars
 * @param {string} prompt
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizePrompt(prompt, maxLen) {
  if (!prompt || !prompt.trim()) return "no-prompt";
  let s = prompt.replace(/\s+/g, " ").trim();
  s = s.replace(/[^A-Za-z0-9 _-]/g, "").trim();
  if (maxLen !== undefined) s = s.slice(0, maxLen).trimEnd();
  s = s.replace(/\s+/g, "-").toLowerCase();
  return s || "no-prompt";
}

/**
 * Format a Date as a filesystem-safe ISO 8601 timestamp.
 * Replaces ":" with "-", drops milliseconds, e.g. "2026-07-13T11-21-45".
 * @param {Date} date
 * @returns {string}
 */
export function formatTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

// ─── Token substitution ───────────────────────────────────────────────────────

/**
 * Substitute tokens in a filename pattern.
 * Supported tokens: {timestamp}, {prompt30}, {promptSlug}, {sessionId}
 * @param {string} pattern
 * @param {{ timestamp: Date, prompt: string, sessionId: string }} ctx
 * @returns {string}
 */
export function substituteTokens(pattern, ctx) {
  const ts = formatTimestamp(ctx.timestamp);
  const prompt30 = sanitizePrompt(ctx.prompt, 30);
  const promptSlug = sanitizePrompt(ctx.prompt, 80);
  const sessionId = (ctx.sessionId || "unknown").slice(0, 8);

  return pattern
    .replace(/\{timestamp\}/g, ts)
    .replace(/\{prompt30\}/g, prompt30)
    .replace(/\{promptSlug\}/g, promptSlug)
    .replace(/\{sessionId\}/g, sessionId);
}

// ─── Filename sanitization ────────────────────────────────────────────────────

// Windows illegal filename chars + path separators
const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Sanitize a full filename: strip illegal chars, cap length, keep extension.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  let safe = name.replace(ILLEGAL_CHARS, "").trim();
  // Cap at 180 chars (preserve extension)
  if (safe.length > 180) {
    const dotIdx = safe.lastIndexOf(".");
    if (dotIdx > 0) {
      const ext = safe.slice(dotIdx);
      safe = safe.slice(0, 180 - ext.length) + ext;
    } else {
      safe = safe.slice(0, 180);
    }
  }
  return safe || "response";
}

/**
 * Build a collision-safe filename: if the base already exists, append -2, -3, …
 * @param {string} dir          Absolute directory path
 * @param {string} baseFilename Already-sanitized filename (may include extension)
 * @param {(p:string)=>boolean} exists  Sync existence checker (injectable for tests)
 * @returns {string}  Final filename (not full path)
 */
export function resolveCollision(dir, baseFilename, exists) {
  const dotIdx = baseFilename.lastIndexOf(".");
  const stem = dotIdx > 0 ? baseFilename.slice(0, dotIdx) : baseFilename;
  const ext = dotIdx > 0 ? baseFilename.slice(dotIdx) : "";

  let candidate = baseFilename;
  let counter = 2;
  while (exists(resolve(dir, candidate))) {
    candidate = `${stem}-${counter}${ext}`;
    counter++;
  }
  return candidate;
}

// ─── File content builders ────────────────────────────────────────────────────

// ── YAML emitter helpers (no runtime dependency — hand-rolled for our schema) ──

/** Normalize all line endings to \n. */
function normalizeEol(str) {
  return str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Emit a double-quoted YAML scalar (safe for known-safe values like timestamps, sessionIds). */
function emitDoubleQuoted(value) {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Emit a double-quoted YAML scalar with full escaping for arbitrary string values.
 * Handles backslash, double-quote, and all control characters.
 */
function emitDoubleQuotedFull(value) {
  let result = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") result += "\\\\";
    else if (ch === '"') result += '\\"';
    else if (ch === "\n") result += "\\n";
    else if (ch === "\r") result += "\\r";
    else if (ch === "\t") result += "\\t";
    else if (ch === "\b") result += "\\b";
    else if (ch === "\f") result += "\\f";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
      result += `\\u${code.toString(16).padStart(4, "0")}`;
    else result += ch;
  }
  return '"' + result + '"';
}

/**
 * Returns true if a normalized value can be safely emitted as a literal block scalar.
 * Block-unsafe conditions:
 *   - Entirely whitespace (spaces/tabs/newlines) — would lose all content.
 *   - Any non-empty line that consists solely of whitespace — YAML treats such lines
 *     as blank (empty) lines in block scalars, discarding their whitespace content.
 */
function isBlockSafe(normalizedValue) {
  if (/^\s*$/.test(normalizedValue)) return false;
  const lines = normalizedValue.split("\n");
  return !lines.some((l) => l.length > 0 && /^\s+$/.test(l));
}

/**
 * Emit a YAML block scalar or double-quoted scalar for an arbitrary string value.
 *
 * Strategy:
 *  - Empty string → `""` (double-quoted empty).
 *  - Not block-safe (entirely whitespace, or has whitespace-only content lines)
 *    → double-quoted scalar with full escaping (always lossless).
 *  - Otherwise → literal block scalar with an EXPLICIT INDENTATION INDICATOR
 *    (`|<N>`) to avoid YAML's auto-detect ambiguity when the first content line
 *    has leading whitespace.  Chomping:
 *      0 trailing newlines → strip `|<N>-`
 *      1 trailing newline  → clip  `|<N>` (default)
 *      2+ trailing newlines → keep `|<N>+`
 *    Blank content lines are emitted as truly empty lines (no indent spaces) so
 *    they don't introduce spurious whitespace-only lines.
 *
 * Note on keep (+) accounting: the caller always appends `\n` after this value,
 * which creates exactly one blank line in the YAML source.  That blank line
 * contributes one trailing newline under keep-chomp.  So we emit (trailingNL − 1)
 * explicit blank lines; the caller's `\n` covers the remaining one.
 *
 * @param {string} value    Raw value; may contain colons, hashes, quotes, tabs, unicode.
 * @param {string} indent   Spaces to prepend to each content line, e.g. "  " or "    ".
 * @returns {string}        Block-scalar header+body, or a double-quoted scalar.
 */
function emitBlockScalarValue(value, indent) {
  if (value === "") return '""';

  const normalized = normalizeEol(value);

  if (!isBlockSafe(normalized)) {
    return emitDoubleQuotedFull(normalized);
  }

  // Count trailing newlines
  let trailingNL = 0;
  let i = normalized.length - 1;
  while (i >= 0 && normalized[i] === "\n") {
    trailingNL++;
    i--;
  }

  // Choose chomping character
  let chomp;
  if (trailingNL === 0) chomp = "-";
  else if (trailingNL === 1) chomp = "";
  else chomp = "+";

  // Strip trailing newlines to get the content portion
  const contentValue = trailingNL > 0 ? normalized.slice(0, -trailingNL) : normalized;

  // Emit each content line indented; blank lines (empty string segments) stay empty
  const contentLines = contentValue.split("\n");
  const emittedLines = contentLines.map((l) => (l === "" ? "" : indent + l));
  let emittedContent = emittedLines.join("\n");

  // For keep (+), the caller's trailing \n provides 1 blank line; emit the rest explicitly
  if (chomp === "+") {
    emittedContent += "\n".repeat(trailingNL - 1);
  }

  // The YAML explicit indentation indicator is *relative*: content indent = contextN + indicator.
  // We always use 2 as the relative indicator.  Content lines are indented by `indent`
  // (= contextN + 2 spaces), so YAML will strip exactly `indent.length` spaces.
  // Contexts used here: top-level keys (n=0, indent="  ") and sequence items (n=2, indent="    "),
  // both resulting in relative indicator 2.
  const indicator = 2;

  return `|${indicator}${chomp}\n${emittedContent}`;
}

/**
 * Build a complete, valid YAML mapping document.
 * Keys in order: timestamp, sessionId, prompt, [messages], response.
 * Scalar strings use double-quoted style; multi-line values use literal block scalars (|-).
 *
 * @param {{ timestamp: Date, sessionId: string, prompt: string, content: string, allMessages: string[] }} data
 * @param {boolean} includeAllMessages
 * @returns {string}
 */
function buildYamlContent(data, includeAllMessages) {
  const { timestamp, sessionId, prompt, content, allMessages } = data;
  const isoTs = timestamp.toISOString();

  let out = "";
  out += `timestamp: ${emitDoubleQuoted(isoTs)}\n`;
  out += `sessionId: ${emitDoubleQuoted(sessionId)}\n`;
  out += `prompt: ${emitBlockScalarValue(prompt, "  ")}\n`;

  if (includeAllMessages && allMessages.length > 0) {
    out += "messages:\n";
    for (const msg of allMessages) {
      out += "  - " + emitBlockScalarValue(msg, "    ") + "\n";
    }
  }

  out += `response: ${emitBlockScalarValue(content, "  ")}\n`;
  return out;
}

/**
 * Build the full file content string.
 * @param {{ timestamp: Date, sessionId: string, prompt: string, content: string, allMessages: string[] }} data
 * @param {"yaml"|"txt"|string} fileFormat  "txt" for plain text; everything else (incl. legacy "md") → yaml.
 * @param {boolean} includeAllMessages
 * @returns {string}
 */
export function buildFileContent(data, fileFormat, includeAllMessages) {
  const { timestamp, sessionId, prompt, content, allMessages } = data;
  const isoTs = timestamp.toISOString();

  if (fileFormat === "txt") {
    let body =
      `timestamp: ${isoTs}\n` +
      `sessionId: ${sessionId}\n` +
      `prompt:\n${prompt}\n` +
      `${"─".repeat(60)}\n\n` +
      content;
    if (includeAllMessages && allMessages.length > 0) {
      body += `\n\n${"─".repeat(60)}\nAll Messages\n${"─".repeat(60)}\n`;
      allMessages.forEach((m, i) => {
        body += `\n[Message ${i + 1}]\n${m}\n`;
      });
    }
    return body;
  }

  // yaml (default) — also handles legacy "md" and any unknown value
  return buildYamlContent(data, includeAllMessages);
}
