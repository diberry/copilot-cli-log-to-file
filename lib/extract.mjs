/**
 * Candidate extraction helpers for copilot-cli-log-to-file captures.
 *
 * Runtime dependency rule: keep this dependency-free. Tests may use js-yaml to
 * validate the review artifact, but the extractor itself uses a small parser for
 * the YAML shape emitted by this repo's capture layer.
 */

import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { pathToFileURL } from "url";

const DEFAULT_INPUT_DIR = "copilot-response-log";
const DEFAULT_DAYS = 7;
const DEFAULT_MIN_COUNT = 2;
const DEFAULT_SOURCE = "yaml";

const COMMAND_PREFIXES = [
  "npm",
  "node",
  "git",
  "gh",
  "python",
  "pip",
  "pwsh",
  "powershell",
];

const EXPLICIT_DIRECTIVE_RE = /\b(always|never|prefer|use|do not|don't|avoid|must|should)\b/i;

/**
 * Run extraction from files through review YAML emission.
 * @param {{ inputDir?: string, days?: number, since?: Date|string, output?: string, minCount?: number, now?: Date, source?: "yaml"|"chronicle"|"both", chronicleDb?: string, sqliteModule?: object|null }} opts
 * @returns {Promise<{ outputPath: string, review: object }>}
 */
export async function runExtraction(opts = {}) {
  const now = opts.now ?? new Date();
  const inputDir = resolve(opts.inputDir ?? DEFAULT_INPUT_DIR);
  const since = opts.since ? new Date(opts.since) : new Date(now.getTime() - (opts.days ?? DEFAULT_DAYS) * 24 * 60 * 60 * 1000);
  const outputPath = resolve(opts.output ?? `candidate-review-${formatFileTimestamp(now)}.yaml`);
  const source = opts.source ?? DEFAULT_SOURCE;
  if (!["yaml", "chronicle", "both"].includes(source)) {
    throw new Error(`unknown source: ${source}`);
  }

  let observations = [];
  const notices = [];
  if (source === "yaml" || source === "both") {
    observations = observations.concat(await loadObservations(inputDir, since, now));
  }
  if (source === "chronicle" || source === "both") {
    const chronicle = await loadChronicleObservations({
      storePath: opts.chronicleDb,
      since,
      until: now,
      sqliteModule: opts.sqliteModule,
    });
    observations = observations.concat(chronicle.observations);
    notices.push(...chronicle.notices);
  }

  observations = dedupeObservations(observations);
  const candidates = extractCandidates(observations, {
    minCount: opts.minCount ?? DEFAULT_MIN_COUNT,
    rootDir: process.cwd(),
  });

  const review = buildReview({
    generatedAt: now,
    inputDir,
    source,
    notices,
    since,
    until: now,
    candidates,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, emitReviewYaml(review), "utf8");
  return { outputPath, review };
}

/**
 * Read capture YAML files in a directory and return normalized observations.
 * @param {string} inputDir
 * @param {Date} since
 * @param {Date} until
 * @returns {Promise<object[]>}
 */
export async function loadObservations(inputDir, since, until) {
  let entries;
  try {
    entries = await readdir(inputDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const files = entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => join(inputDir, e.name))
    .sort((a, b) => a.localeCompare(b));

  const observations = [];
  for (const filePath of files) {
    const raw = await readFile(filePath, "utf8");
    const parsed = parseCaptureYaml(raw);
    if (!parsed.timestamp) continue;

    const ts = new Date(parsed.timestamp);
    if (Number.isNaN(ts.getTime())) continue;
    if (ts < since || ts > until) continue;

    observations.push({
      source: filePath,
      sourceType: "yaml",
      timestamp: ts.toISOString(),
      sessionId: parsed.sessionId ?? "unknown",
      prompt: parsed.prompt ?? "",
      response: parsed.response ?? "",
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    });
  }

  return observations;
}

/**
 * Read Copilot CLI /chronicle's local SQLite store as an additive evidence
 * source. The store is opened read-only and normalized to the same observation
 * shape as YAML captures.
 * @param {{ storePath?: string, since: Date, until: Date, sqliteModule?: object|null }} opts
 * @returns {Promise<{ observations: object[], notices: string[] }>}
 */
export async function loadChronicleObservations(opts) {
  const notices = [];
  const storePath = resolve(opts.storePath ?? defaultChronicleStorePath());

  if (!existsSync(storePath)) {
    notices.push(`chronicle store not found at ${storePath}; skipped chronicle source`);
    return { observations: [], notices };
  }

  const sqlite = await resolveSqliteModule(opts);
  if (!sqlite?.DatabaseSync) {
    notices.push("node:sqlite is unavailable in this Node.js runtime; skipped chronicle source");
    return { observations: [], notices };
  }

  let db;
  try {
    db = new sqlite.DatabaseSync(`${pathToFileURL(storePath).href}?mode=ro`);
  } catch (err) {
    notices.push(`failed to open chronicle store read-only: ${err.message}`);
    return { observations: [], notices };
  }

  try {
    const sinceDate = datePrefix(opts.since);
    const untilDate = datePrefix(opts.until);
    const rows = db.prepare(`
      SELECT
        t.id AS turn_id,
        t.session_id AS session_id,
        t.turn_index AS turn_index,
        t.user_message AS user_message,
        t.assistant_response AS assistant_response,
        t.timestamp AS turn_timestamp,
        s.cwd AS cwd,
        s.repository AS repository,
        s.host_type AS host_type,
        s.branch AS branch,
        s.created_at AS session_created_at
      FROM turns t
      LEFT JOIN sessions s ON s.id = t.session_id
      WHERE substr(COALESCE(t.timestamp, s.created_at, ''), 1, 10) >= ?
        AND substr(COALESCE(t.timestamp, s.created_at, ''), 1, 10) <= ?
      ORDER BY COALESCE(t.timestamp, s.created_at, ''), t.session_id, t.turn_index
    `).all(sinceDate, untilDate);

    const observations = rows
      .filter((row) => row.user_message || row.assistant_response)
      .map((row) => ({
        source: `chronicle:${row.session_id}:${row.turn_index}`,
        sourceType: "chronicle",
        timestamp: normalizeTimestamp(row.turn_timestamp ?? row.session_created_at),
        sessionId: row.session_id ?? "unknown",
        turnIndex: row.turn_index,
        prompt: row.user_message ?? "",
        response: row.assistant_response ?? "",
        messages: [],
        files: loadChronicleFiles(db, row.session_id, row.turn_index),
        refs: loadChronicleRefs(db, row.session_id, row.turn_index),
        usage: loadChronicleUsage(db, row.session_id, row.turn_index),
        chronicle: {
          cwd: row.cwd ?? "",
          repository: row.repository ?? "",
          host_type: row.host_type ?? "",
          branch: row.branch ?? "",
        },
      }));

    return { observations, notices };
  } finally {
    db.close();
  }
}

/**
 * Parse the capture-layer YAML shape:
 *   timestamp: "..."
 *   sessionId: "..."
 *   prompt: |2-
 *     ...
 *   messages:
 *     - |2-
 *       ...
 *   response: |2-
 *     ...
 *
 * It intentionally ignores unknown enriched blocks so future capture fields do
 * not break extraction.
 * @param {string} raw
 * @returns {{ timestamp?: string, sessionId?: string, prompt?: string, response?: string, messages?: string[] }}
 */
export function parseCaptureYaml(raw) {
  const lines = normalizeEol(raw).split("\n");
  const result = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const topMatch = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!topMatch) continue;

    const key = topMatch[1];
    const rest = topMatch[2] ?? "";

    if (key === "messages" && rest === "") {
      const parsed = readSequence(lines, i + 1);
      result.messages = parsed.values;
      i = parsed.nextIndex - 1;
      continue;
    }

    if (isBlockHeader(rest)) {
      const parsed = readBlockScalar(lines, i + 1, 2, rest);
      if (isCaptureKey(key)) result[key] = parsed.value;
      i = parsed.nextIndex - 1;
      continue;
    }

    if (isCaptureKey(key)) {
      result[key] = parseScalar(rest);
    }
  }

  return result;
}

/**
 * Produce candidate facts from observations. Candidates require repeated support
 * by default; a one-off line never becomes a candidate.
 * @param {object[]} observations
 * @param {{ minCount?: number, rootDir?: string }} opts
 * @returns {object[]}
 */
export function extractCandidates(observations, opts = {}) {
  const minCount = opts.minCount ?? DEFAULT_MIN_COUNT;
  const rootDir = opts.rootDir ?? process.cwd();
  const groups = new Map();

  for (const obs of observations) {
    for (const signal of observationSignals(obs)) {
      addSignal(groups, signal, obs, rootDir);
    }
  }

  return [...groups.values()]
    .filter((g) => g.count >= minCount && g.sessions.size >= Math.min(minCount, 2))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .map((g, index) => ({
      id: `cand-${String(index + 1).padStart(3, "0")}-${g.slug}`,
      proposed_fact: g.proposedFact,
      category: g.category,
      target_file: g.targetFile,
      confidence: confidenceFor(g.count, g.sessions.size),
      status: "pending",
      approve: false,
      reject: false,
      refined_fact: "",
      reviewer_notes: "",
      evidence: g.evidence,
    }));
}

export function buildReview({ generatedAt, inputDir, source = DEFAULT_SOURCE, notices = [], since, until, candidates }) {
  return {
    generated_at: generatedAt.toISOString(),
    source_log_dir: inputDir,
    source,
    notices,
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
    },
    instructions: "Edit status to approved, rejected, or refined. If refined, set refined_fact. Merge the PR only after human review.",
    candidates,
  };
}

export function emitReviewYaml(review) {
  let out = "";
  out += `generated_at: ${dq(review.generated_at)}\n`;
  out += `source_log_dir: ${dq(review.source_log_dir)}\n`;
  out += `source: ${dq(review.source)}\n`;
  out += "notices:\n";
  if (review.notices.length === 0) {
    out += "  []\n";
  } else {
    for (const notice of review.notices) out += `  - ${dq(notice)}\n`;
  }
  out += "window:\n";
  out += `  since: ${dq(review.window.since)}\n`;
  out += `  until: ${dq(review.window.until)}\n`;
  out += `instructions: ${block(review.instructions, "  ")}\n`;
  out += "candidates:\n";

  if (review.candidates.length === 0) {
    out += "  []\n";
    return out;
  }

  for (const candidate of review.candidates) {
    out += `  - id: ${dq(candidate.id)}\n`;
    out += `    proposed_fact: ${block(candidate.proposed_fact, "      ")}\n`;
    out += `    category: ${dq(candidate.category)}\n`;
    out += `    target_file: ${dq(candidate.target_file)}\n`;
    out += `    confidence: ${dq(candidate.confidence)}\n`;
    out += `    status: ${dq(candidate.status)}\n`;
    out += `    approve: ${candidate.approve ? "true" : "false"}\n`;
    out += `    reject: ${candidate.reject ? "true" : "false"}\n`;
    out += `    refined_fact: ${dq(candidate.refined_fact)}\n`;
    out += `    reviewer_notes: ${dq(candidate.reviewer_notes)}\n`;
    out += "    evidence:\n";
    for (const item of candidate.evidence) {
      out += `      - source: ${dq(item.source)}\n`;
      out += `        timestamp: ${dq(item.timestamp)}\n`;
      out += `        sessionId: ${dq(item.sessionId)}\n`;
      out += `        count: ${item.count}\n`;
      out += `        quote: ${block(item.quote, "          ")}\n`;
    }
  }

  return out;
}

function observationSignals(obs) {
  const signals = [];
  const combined = `${obs.prompt}\n${obs.response}`;
  const lower = combined.toLowerCase();

  if (/\btargeted\b/.test(lower) && /\b(validation|test|tests|lint)\b/.test(lower) && /\b(full[- ]?suite|broader|full)\b/.test(lower)) {
    signals.push({
      key: "workflow:targeted-before-full-validation",
      slug: "targeted-validation",
      category: "workflow-preference",
      targetFile: "context/workflow.md",
      proposedFact: "You often prefer targeted validation before broader or full-suite validation.",
      quote: firstMatchingLine(combined, /\btargeted\b/i) ?? trimQuote(combined),
    });
  }

  for (const command of extractCommands(combined)) {
    signals.push({
      key: `command:${normalizeCommand(command)}`,
      slug: slugify(normalizeCommand(command)).slice(0, 40),
      category: "tooling-pattern",
      targetFile: "context/tooling.md",
      proposedFact: `You repeatedly used \`${normalizeCommand(command)}\` in Copilot CLI sessions. Consider whether this is a durable tooling pattern.`,
      quote: command,
    });
  }

  for (const directive of extractExplicitDirectives(obs.prompt)) {
    signals.push({
      key: `directive:${normalizeDirective(directive)}`,
      slug: slugify(normalizeDirective(directive)).slice(0, 40),
      category: "user-stated-preference",
      targetFile: "context/preferences.md",
      proposedFact: `Repeated user-stated preference candidate: ${directive}`,
      quote: directive,
    });
  }

  return signals;
}

function addSignal(groups, signal, obs, rootDir) {
  if (!groups.has(signal.key)) {
    groups.set(signal.key, {
      ...signal,
      count: 0,
      sessions: new Set(),
      evidenceBySource: new Map(),
      evidence: [],
    });
  }

  const group = groups.get(signal.key);
  group.count++;
  group.sessions.add(obs.sessionId);

  const source = relative(rootDir, obs.source) || obs.source;
  const key = `${source}\0${obs.sessionId}`;
  const existing = group.evidenceBySource.get(key);
  if (existing) {
    existing.count++;
    return;
  }

  const item = {
    source,
    timestamp: obs.timestamp,
    sessionId: obs.sessionId,
    count: 1,
    quote: trimQuote(signal.quote),
  };
  group.evidenceBySource.set(key, item);
  group.evidence.push(item);
}

async function resolveSqliteModule(opts) {
  if (opts.sqliteModule !== undefined) return opts.sqliteModule;
  try {
    return await import("node:sqlite");
  } catch (_err) {
    return null;
  }
}

function defaultChronicleStorePath() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return join(home, ".copilot", "session-store.db");
}

function loadChronicleFiles(db, sessionId, turnIndex) {
  try {
    return db.prepare(`
      SELECT file_path, tool_name, first_seen_at
      FROM session_files
      WHERE session_id = ? AND turn_index = ?
      ORDER BY file_path
    `).all(sessionId, turnIndex);
  } catch (_err) {
    return [];
  }
}

function loadChronicleRefs(db, sessionId, turnIndex) {
  try {
    return db.prepare(`
      SELECT ref_type, ref_value, created_at
      FROM session_refs
      WHERE session_id = ? AND turn_index = ?
      ORDER BY ref_type, ref_value
    `).all(sessionId, turnIndex);
  } catch (_err) {
    return [];
  }
}

function loadChronicleUsage(db, sessionId, turnIndex) {
  try {
    return db.prepare(`
      SELECT model, input_tokens, output_tokens, duration_ms, finish_reason
      FROM assistant_usage_events
      WHERE session_id = ? AND turn_index = ?
      ORDER BY rowid
    `).all(sessionId, turnIndex);
  } catch (_err) {
    return [];
  }
}

function dedupeObservations(observations) {
  const byKey = new Map();
  for (const obs of observations) {
    const key = [
      datePrefix(new Date(obs.timestamp)),
      obs.sessionId,
      normalizeForDedupe(obs.prompt),
      normalizeForDedupe(obs.prompt) ? "" : normalizeForDedupe(obs.response),
    ].join("\0");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, obs);
      continue;
    }
    if (existing.sourceType === "chronicle" && obs.sourceType === "yaml") {
      byKey.set(key, obs);
    }
  }
  return [...byKey.values()];
}

function normalizeForDedupe(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function datePrefix(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function normalizeTimestamp(value) {
  const raw = String(value ?? "");
  if (!raw) return new Date(0).toISOString();
  if (/^\d{4}-\d{2}-\d{2}[ T]/.test(raw) && !/[zZ]|[+-]\d\d:?\d\d$/.test(raw)) {
    const asUtc = new Date(raw.replace(" ", "T") + "Z");
    if (!Number.isNaN(asUtc.getTime())) return asUtc.toISOString();
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  const normalized = new Date(raw.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? "" : "Z"));
  if (!Number.isNaN(normalized.getTime())) return normalized.toISOString();
  return raw;
}

function extractCommands(text) {
  const commands = new Set();
  const lineRe = /^\s*(?:[$>]\s*)?((?:npm|node|git|gh|python|pip|pwsh|powershell)\b[^\n\r]*)/gim;
  let match;
  while ((match = lineRe.exec(text)) !== null) {
    commands.add(cleanCommand(match[1]));
  }

  const inlineRe = /`((?:npm|node|git|gh|python|pip|pwsh|powershell)\b[^`]{1,120})`/gim;
  while ((match = inlineRe.exec(text)) !== null) {
    commands.add(cleanCommand(match[1]));
  }

  return [...commands].filter((cmd) => {
    const first = cmd.split(/\s+/)[0].toLowerCase();
    return COMMAND_PREFIXES.includes(first);
  });
}

function extractExplicitDirectives(prompt) {
  return prompt
    .split(/\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 220 && EXPLICIT_DIRECTIVE_RE.test(s))
    .map((s) => s.replace(/\s+/g, " "));
}

function readSequence(lines, startIndex) {
  const values = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const itemMatch = /^  -(?:\s*(.*))?$/.exec(line);
    if (!itemMatch) {
      i++;
      continue;
    }

    const rest = itemMatch[1] ?? "";
    if (isBlockHeader(rest)) {
      const parsed = readBlockScalar(lines, i + 1, 4, rest);
      values.push(parsed.value);
      i = parsed.nextIndex;
    } else {
      values.push(parseScalar(rest));
      i++;
    }
  }

  return { values, nextIndex: i };
}

function readBlockScalar(lines, startIndex, indent, header) {
  const rawLines = [];
  let i = startIndex;
  const indentRe = new RegExp(`^ {${indent}}(.*)$`);

  while (i < lines.length) {
    const line = lines[i];
    if (line === "") {
      if (i === lines.length - 1) break;
      rawLines.push("");
      i++;
      continue;
    }

    const match = indentRe.exec(line);
    if (!match) break;
    rawLines.push(match[1]);
    i++;
  }

  let value = rawLines.join("\n");
  if (!header.endsWith("-")) value += "\n";
  if (header.endsWith("+")) value += "\n";
  return { value, nextIndex: i };
}

function isBlockHeader(rest) {
  return /^\|[0-9]?[+-]?$/.test(rest.trim());
}

function isCaptureKey(key) {
  return key === "timestamp" || key === "sessionId" || key === "prompt" || key === "response";
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === '""') return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed);
  }
  return trimmed;
}

function cleanCommand(command) {
  return command
    .replace(/\s+#.*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function normalizeCommand(command) {
  return cleanCommand(command).replace(/(["'])(?:C:\\[^"']+|[A-Za-z]:\\[^"']+)\1/g, "$1<path>$1");
}

function normalizeDirective(directive) {
  return directive.toLowerCase().replace(/\s+/g, " ").trim();
}

function confidenceFor(count, sessions) {
  if (count >= 5 && sessions >= 3) return "high";
  if (count >= 3 || sessions >= 2) return "medium";
  return "low";
}

function firstMatchingLine(text, re) {
  return text.split(/\r?\n/).find((line) => re.test(line.trim()));
}

function trimQuote(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function normalizeEol(str) {
  return str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function dq(value) {
  return JSON.stringify(String(value));
}

function block(value, indent) {
  const text = String(value);
  if (text === "") return '""';
  return `|-\n${normalizeEol(text).split("\n").map((line) => indent + line).join("\n")}`;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "candidate";
}

function formatFileTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}
