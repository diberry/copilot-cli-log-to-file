/**
 * format.mjs — Pure helpers for copilot-cli-log-to-file extension.
 * No SDK imports here so these functions are testable standalone.
 */

import { readFileSync } from "fs";
import { resolve, isAbsolute } from "path";

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  outputDir: "copilot-response-log",
  filenamePattern: "{timestamp}-{prompt30}.md",
  includeAllMessages: false,
  fileFormat: "md",
};

// ─── Config loading ───────────────────────────────────────────────────────────

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
    if (parsed.fileFormat !== undefined && ["md", "txt"].includes(parsed.fileFormat)) {
      cfg.fileFormat = parsed.fileFormat;
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
  if (process.env.COPILOT_LOG_FORMAT && ["md", "txt"].includes(process.env.COPILOT_LOG_FORMAT)) {
    cfg.fileFormat = process.env.COPILOT_LOG_FORMAT;
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

/**
 * Build the full file content string.
 * @param {{ timestamp: Date, sessionId: string, prompt: string, content: string, allMessages: string[] }} data
 * @param {"md"|"txt"} fileFormat
 * @param {boolean} includeAllMessages
 * @returns {string}
 */
export function buildFileContent(data, fileFormat, includeAllMessages) {
  const { timestamp, sessionId, prompt, content, allMessages } = data;
  const isoTs = timestamp.toISOString();

  if (fileFormat === "md") {
    const indentedPrompt = prompt
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
    let body = `---\ntimestamp: ${isoTs}\nsessionId: ${sessionId}\nprompt: |\n${indentedPrompt}\n---\n\n${content}`;
    if (includeAllMessages && allMessages.length > 0) {
      body += `\n\n---\n\n## All Messages\n\n`;
      allMessages.forEach((m, i) => {
        body += `### Message ${i + 1}\n\n${m}\n\n`;
      });
    }
    return body;
  } else {
    // txt
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
}
