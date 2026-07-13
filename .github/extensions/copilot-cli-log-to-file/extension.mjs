/**
 * extension.mjs — copilot-cli-log-to-file
 *
 * Logs the final assistant response for every Copilot CLI turn to a
 * timestamped file. Output directory and filename pattern are configurable
 * via config.json (next to this file) and/or environment variables.
 *
 * IMPORTANT: console.log() is forbidden — stdout is reserved for JSON-RPC.
 * All user-visible messages go through session.log().
 *
 * @github/copilot-sdk is NOT listed in package.json; it is provided by the
 * Copilot CLI at runtime and resolves only when run inside the CLI.
 */

import { joinSession } from "@github/copilot-sdk/extension";
import { mkdir, writeFile, access } from "fs/promises";
import { constants } from "fs";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import {
  loadConfig,
  resolveOutputDir,
  substituteTokens,
  sanitizeFilename,
  resolveCollision,
  buildFileContent,
} from "./lib/format.mjs";

// ─── Module-level state ───────────────────────────────────────────────────────

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

/** @type {{ prompt: string, ts: Date } | null} */
let pending = null;
/** @type {string | null} */
let lastAssistant = null;
/** @type {string[]} */
let allMessages = [];

// ─── Session ──────────────────────────────────────────────────────────────────

const session = await joinSession({
  tools: [],
  hooks: {
    onUserPromptSubmitted(input) {
      pending = { prompt: input.prompt ?? "", ts: input.timestamp ?? new Date() };
      lastAssistant = null;
      allMessages = [];
    },

    onSessionEnd(_input) {
      // Final clean-up: if a turn was left pending (session ended before idle),
      // try to write whatever was captured.
      if (pending && lastAssistant) {
        flushLog(session, pending, lastAssistant, allMessages).catch(() => {});
        pending = null;
        lastAssistant = null;
        allMessages = [];
      }
    },
  },
});

// ─── Event subscriptions ──────────────────────────────────────────────────────

session.on("assistant.message", (event) => {
  const content = event?.data?.content;
  if (!content) return;
  lastAssistant = content; // overwrite — we want the LAST message before idle
  allMessages.push(content);
});

session.on("session.idle", async () => {
  if (!pending || !lastAssistant) return;

  const snap = { ...pending };
  const assistantSnap = lastAssistant;
  const allSnap = [...allMessages];

  // Clear before async work to prevent double-write
  pending = null;
  lastAssistant = null;
  allMessages = [];

  await flushLog(session, snap, assistantSnap, allSnap);
});

// ─── Core write logic ─────────────────────────────────────────────────────────

/**
 * Write one log file for a completed turn.
 */
async function flushLog(session, snap, assistantContent, allMsgs) {
  const cfg = loadConfig(EXTENSION_DIR, (msg) =>
    session.log(msg, { level: "warning" })
  );

  const workingDir = snap.workingDirectory ?? process.cwd();
  const outputDir = resolveOutputDir(cfg.outputDir, workingDir);

  try {
    await mkdir(outputDir, { recursive: true });
  } catch (err) {
    session.log(`copilot-cli-log-to-file: failed to create output dir "${outputDir}": ${err.message}`, {
      level: "error",
    });
    return;
  }

  // Build filename
  const rawFilename = substituteTokens(cfg.filenamePattern, {
    timestamp: snap.ts,
    prompt: snap.prompt,
    sessionId: session.invocation?.sessionId ?? "unknown",
  });

  const ext = cfg.fileFormat === "txt" ? ".txt" : ".md";
  const patternHasExt = rawFilename.endsWith(".md") || rawFilename.endsWith(".txt");
  const withExt = patternHasExt ? rawFilename : rawFilename + ext;
  const safeFilename = sanitizeFilename(withExt);

  const finalFilename = resolveCollision(
    outputDir,
    safeFilename,
    (p) => existsSync(p)
  );
  const filePath = resolve(outputDir, finalFilename);

  // Build content
  const content = buildFileContent(
    {
      timestamp: snap.ts,
      sessionId: session.invocation?.sessionId ?? "unknown",
      prompt: snap.prompt,
      content: assistantContent,
      allMessages: allMsgs,
    },
    cfg.fileFormat,
    cfg.includeAllMessages
  );

  try {
    await writeFile(filePath, content, "utf8");
    session.log(`copilot-cli-log-to-file: wrote → ${filePath}`, { level: "info" });
  } catch (err) {
    session.log(`copilot-cli-log-to-file: write failed "${filePath}": ${err.message}`, {
      level: "error",
    });
  }
}
