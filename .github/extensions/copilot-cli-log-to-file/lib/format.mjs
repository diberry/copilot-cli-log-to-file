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
  capture: {
    attachments: false,
    reasoning: false,
    toolCalls: false,
    toolResults: false,
    usage: false,
    model: false,
    skills: false,
    subagents: false,
    permissions: false,
    errors: false,
    lifecycle: false,
    turns: false,
    schedules: false,
    notifications: false,
  },
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
  let cfg = { ...DEFAULTS, capture: { ...DEFAULTS.capture } };

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
    // Capture toggles from config.json
    if (parsed.capture && typeof parsed.capture === "object") {
      for (const key of Object.keys(DEFAULTS.capture)) {
        if (parsed.capture[key] !== undefined) {
          cfg.capture[key] = Boolean(parsed.capture[key]);
        }
      }
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

  // Capture toggles from env vars — individual overrides
  for (const key of Object.keys(DEFAULTS.capture)) {
    const envKey = `COPILOT_LOG_CAPTURE_${key.toUpperCase()}`;
    if (process.env[envKey] !== undefined) {
      cfg.capture[key] = process.env[envKey] === "true";
    }
  }

  // Master override: COPILOT_LOG_CAPTURE_ALL=true enables all capture toggles
  if (process.env.COPILOT_LOG_CAPTURE_ALL === "true") {
    for (const key of Object.keys(cfg.capture)) {
      cfg.capture[key] = true;
    }
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
 *   - Contains a control character that is illegal inside a YAML block scalar.
 *     Legal low-range chars are 0x09 (tab) and 0x0A (newline); everything else in
 *     0x00–0x1F, plus 0x7F (DEL) and 0x80–0x9F (C1), must be escaped → double-quoted.
 */
function hasUnprintable(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if ((c >= 0x00 && c <= 0x08) || c === 0x0b || c === 0x0c ||
        (c >= 0x0e && c <= 0x1f) || c === 0x7f ||
        (c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}

function isBlockSafe(normalizedValue) {
  if (/^\s*$/.test(normalizedValue)) return false;
  if (hasUnprintable(normalizedValue)) return false;
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

// ─── Captured data serialization helpers ─────────────────────────────────────

/** Safely emit a primitive value as YAML: double-quote strings, booleans/numbers/null as-is. */
function emitYamlPrimitive(val) {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  return emitDoubleQuotedFull(String(val));
}

/** Emit a YAML array of primitives, one per line. */
function emitYamlArray(arr, indent) {
  if (!Array.isArray(arr) || arr.length === 0) return "[]";
  let out = "";
  for (const item of arr) {
    out += `${indent}- ${emitYamlPrimitive(item)}\n`;
  }
  return out;
}

/** Emit a YAML mapping of primitives. */
function emitYamlMapping(obj, indent) {
  if (!obj || typeof obj !== "object" || Object.keys(obj).length === 0) return "{}";
  let out = "\n";
  for (const [key, val] of Object.entries(obj)) {
    out += `${indent}${key}: ${emitYamlPrimitive(val)}\n`;
  }
  return out.trimEnd();
}

/**
 * Append captured data as YAML sections, only when enabled AND non-empty.
 * Stable order: attachments, reasoning, toolCalls, usage, model, skills, subagents, permissions, errors, lifecycle, turns, schedules, notifications.
 */
function appendCapturedDataYaml(captured, toggles) {
  let out = "";

  // 1. Attachments
  if (toggles.attachments && captured.attachments?.length > 0) {
    out += "attachments:\n";
    for (const att of captured.attachments) {
      out += `  - type: ${emitYamlPrimitive(att.type)}\n`;
      if (att.path) out += `    path: ${emitYamlPrimitive(att.path)}\n`;
      if (att.displayName) out += `    displayName: ${emitYamlPrimitive(att.displayName)}\n`;
    }
  }

  // 2. Reasoning
  if (toggles.reasoning && captured.reasoning?.length > 0) {
    out += "reasoning:\n";
    for (const r of captured.reasoning) {
      out += "  - " + emitBlockScalarValue(r.content || "", "    ") + "\n";
    }
  }

  // 3. Tool calls (merged start + complete)
  if ((toggles.toolCalls || toggles.toolResults) && captured.tools?.length > 0) {
    out += "tools:\n";
    for (const t of captured.tools) {
      out += `  - toolCallId: ${emitYamlPrimitive(t.toolCallId)}\n`;
      if (t.toolName) out += `    toolName: ${emitYamlPrimitive(t.toolName)}\n`;
      if (t.arguments) out += `    arguments: ${emitBlockScalarValue(t.arguments, "      ")}\n`;
      if (t.success !== undefined) out += `    success: ${t.success}\n`;
      if (t.result) out += `    result: ${emitBlockScalarValue(t.result, "      ")}\n`;
      if (t.error) out += `    error: ${emitYamlPrimitive(t.error)}\n`;
    }
  }

  // 4. Usage
  if (toggles.usage && captured.usage?.length > 0) {
    out += "usage:\n";
    for (const u of captured.usage) {
      out += "  - " + emitYamlMapping(u, "    ");
    }
  }

  // 5. Model
  if (toggles.model && captured.model?.length > 0) {
    out += "model:\n";
    for (const m of captured.model) {
      out += "  - " + emitYamlMapping(m, "    ");
    }
  }

  // 6. Skills
  if (toggles.skills && captured.skills?.length > 0) {
    out += "skills:\n";
    for (const s of captured.skills) {
      out += "  - " + emitYamlMapping(s, "    ");
    }
  }

  // 7. Subagents
  if (toggles.subagents && captured.subagents?.length > 0) {
    out += "subagents:\n";
    for (const sa of captured.subagents) {
      out += "  - " + emitYamlMapping(sa, "    ");
    }
  }

  // 8. Permissions
  if (toggles.permissions && captured.permissions?.length > 0) {
    out += "permissions:\n";
    for (const p of captured.permissions) {
      out += "  - " + emitYamlMapping(p, "    ");
    }
  }

  // 9. Errors
  if (toggles.errors && captured.errors?.length > 0) {
    out += "errors:\n";
    for (const e of captured.errors) {
      out += "  - " + emitYamlMapping(e, "    ");
    }
  }

  // 10. Lifecycle
  if (toggles.lifecycle && captured.lifecycle?.length > 0) {
    out += "lifecycle:\n";
    for (const lc of captured.lifecycle) {
      out += "  - " + emitYamlMapping(lc, "    ");
    }
  }

  // 11. Turns
  if (toggles.turns && captured.turns?.length > 0) {
    out += "turns:\n";
    for (const tn of captured.turns) {
      out += "  - " + emitYamlMapping(tn, "    ");
    }
  }

  // 12. Schedules
  if (toggles.schedules && captured.schedules?.length > 0) {
    out += "schedules:\n";
    for (const sc of captured.schedules) {
      out += "  - " + emitYamlMapping(sc, "    ");
    }
  }

  // 13. Notifications
  if (toggles.notifications && captured.notifications?.length > 0) {
    out += "notifications:\n";
    for (const n of captured.notifications) {
      out += "  - " + emitYamlMapping(n, "    ");
    }
  }

  return out;
}

/**
 * Append captured data as txt sections.
 */
function appendCapturedDataTxt(captured, toggles) {
  let out = "";
  const sep = "─".repeat(60);

  if (toggles.attachments && captured.attachments?.length > 0) {
    out += `\n\n${sep}\nAttachments\n${sep}\n`;
    captured.attachments.forEach((att, i) => {
      out += `\n[Attachment ${i + 1}] ${att.type}: ${att.displayName || att.path}\n`;
    });
  }

  if (toggles.reasoning && captured.reasoning?.length > 0) {
    out += `\n\n${sep}\nReasoning\n${sep}\n`;
    captured.reasoning.forEach((r, i) => {
      out += `\n[Reasoning ${i + 1}]\n${r.content}\n`;
    });
  }

  if ((toggles.toolCalls || toggles.toolResults) && captured.tools?.length > 0) {
    out += `\n\n${sep}\nTools\n${sep}\n`;
    captured.tools.forEach((t, i) => {
      out += `\n[Tool ${i + 1}] ${t.toolName} (${t.toolCallId})\n`;
      if (t.arguments) out += `Arguments: ${t.arguments}\n`;
      if (t.success !== undefined) out += `Success: ${t.success}\n`;
      if (t.result) out += `Result: ${t.result}\n`;
      if (t.error) out += `Error: ${t.error}\n`;
    });
  }

  if (toggles.usage && captured.usage?.length > 0) {
    out += `\n\n${sep}\nUsage\n${sep}\n`;
    captured.usage.forEach((u, i) => {
      out += `\n[Usage ${i + 1}]\n${JSON.stringify(u, null, 2)}\n`;
    });
  }

  if (toggles.model && captured.model?.length > 0) {
    out += `\n\n${sep}\nModel\n${sep}\n`;
    captured.model.forEach((m, i) => {
      out += `\n[Model ${i + 1}]\n${JSON.stringify(m, null, 2)}\n`;
    });
  }

  if (toggles.skills && captured.skills?.length > 0) {
    out += `\n\n${sep}\nSkills\n${sep}\n`;
    captured.skills.forEach((s, i) => {
      out += `\n[Skill ${i + 1}]\n${JSON.stringify(s, null, 2)}\n`;
    });
  }

  if (toggles.subagents && captured.subagents?.length > 0) {
    out += `\n\n${sep}\nSubagents\n${sep}\n`;
    captured.subagents.forEach((sa, i) => {
      out += `\n[Subagent ${i + 1}]\n${JSON.stringify(sa, null, 2)}\n`;
    });
  }

  if (toggles.permissions && captured.permissions?.length > 0) {
    out += `\n\n${sep}\nPermissions\n${sep}\n`;
    captured.permissions.forEach((p, i) => {
      out += `\n[Permission ${i + 1}]\n${JSON.stringify(p, null, 2)}\n`;
    });
  }

  if (toggles.errors && captured.errors?.length > 0) {
    out += `\n\n${sep}\nErrors\n${sep}\n`;
    captured.errors.forEach((e, i) => {
      out += `\n[Error ${i + 1}]\n${JSON.stringify(e, null, 2)}\n`;
    });
  }

  if (toggles.lifecycle && captured.lifecycle?.length > 0) {
    out += `\n\n${sep}\nLifecycle\n${sep}\n`;
    captured.lifecycle.forEach((lc, i) => {
      out += `\n[Lifecycle ${i + 1}]\n${JSON.stringify(lc, null, 2)}\n`;
    });
  }

  if (toggles.turns && captured.turns?.length > 0) {
    out += `\n\n${sep}\nTurns\n${sep}\n`;
    captured.turns.forEach((tn, i) => {
      out += `\n[Turn ${i + 1}]\n${JSON.stringify(tn, null, 2)}\n`;
    });
  }

  if (toggles.schedules && captured.schedules?.length > 0) {
    out += `\n\n${sep}\nSchedules\n${sep}\n`;
    captured.schedules.forEach((sc, i) => {
      out += `\n[Schedule ${i + 1}]\n${JSON.stringify(sc, null, 2)}\n`;
    });
  }

  if (toggles.notifications && captured.notifications?.length > 0) {
    out += `\n\n${sep}\nNotifications\n${sep}\n`;
    captured.notifications.forEach((n, i) => {
      out += `\n[Notification ${i + 1}]\n${JSON.stringify(n, null, 2)}\n`;
    });
  }

  return out;
}

// ─── File content builders ────────────────────────────────────────────────────

/**
 * Build a complete, valid YAML mapping document.
 * Keys in order: timestamp, sessionId, prompt, [messages], response, [captured sections].
 * Scalar strings use double-quoted style; multi-line values use literal block scalars (|-).
 *
 * @param {{ timestamp: Date, sessionId: string, prompt: string, content: string, allMessages: string[], capturedData?: any }} data
 * @param {boolean} includeAllMessages
 * @param {any} [capturedData]  Optional captured event data.
 * @param {{capture: typeof DEFAULTS.capture}} [cfg]  Optional config with capture toggles.
 * @returns {string}
 */
function buildYamlContent(data, includeAllMessages, capturedData, cfg) {
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

  // Append captured sections in stable order if present
  if (capturedData && cfg?.capture) {
    out += appendCapturedDataYaml(capturedData, cfg.capture);
  }

  return out;
}

/**
 * Build the full file content string.
 * @param {{ timestamp: Date, sessionId: string, prompt: string, content: string, allMessages: string[], capturedData?: any }} data
 * @param {"yaml"|"txt"|string} fileFormat  "txt" for plain text; everything else (incl. legacy "md") → yaml.
 * @param {boolean} includeAllMessages
 * @param {{capture: typeof DEFAULTS.capture}} [cfg]  Optional config with capture toggles.
 * @returns {string}
 */
export function buildFileContent(data, fileFormat, includeAllMessages, cfg) {
  const { timestamp, sessionId, prompt, content, allMessages, capturedData } = data;
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
    // Append captured data in txt format if present
    if (capturedData && cfg?.capture) {
      body += appendCapturedDataTxt(capturedData, cfg.capture);
    }
    return body;
  }

  // yaml (default) — also handles legacy "md" and any unknown value
  return buildYamlContent(data, includeAllMessages, capturedData, cfg);
}
