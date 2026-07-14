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
import { mkdir, writeFile } from "fs/promises";
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

// ─── Per-turn and per-session buffers ────────────────────────────────────────
// pending: holds current turn metadata (prompt, sessionId, timestamp) from hook → idle.
// lastAssistant: last assistant.message content before idle (overwrites on multiple messages).
// allMessages: all assistant.message content in chronological order (when includeAllMessages=true).
// capturedData: per-turn event buffers (tools, usage, reasoning, etc.) reset each prompt, flushed on idle.
// capturedData.tools: merged start+complete events by toolCallId — toolCalls+toolResults toggles feed ONE "tools:" YAML block.

/** @type {{ prompt: string, ts: Date, sessionId: string, workingDirectory: string, id: number, agentMode?: string, attachments?: any[] } | null} */
let pending = null;
/** @type {string | null} */
let lastAssistant = null;
/** @type {string[]} */
let allMessages = [];

/** @type {{ attachments: any[], reasoning: any[], tools: any[], usage: any[], model: any[], skills: any[], subagents: any[], permissions: any[], errors: any[], lifecycle: any[], turns: any[], schedules: any[], notifications: any[] }} */
let capturedData = resetCapturedData();

// Idempotency guard: each turn gets a unique id; flushedTurnId tracks what was already written.
let turnId = 0;
let flushedTurnId = -1;

function resetCapturedData() {
  return {
    attachments: [],
    reasoning: [],
    tools: [],      // Merged start + complete by toolCallId
    usage: [],
    model: [],
    skills: [],
    subagents: [],
    permissions: [],
    errors: [],
    lifecycle: [],
    turns: [],
    schedules: [],
    notifications: [],
  };
}

// ─── Session ──────────────────────────────────────────────────────────────────

const session = await joinSession({
  tools: [],
  hooks: {
    onUserPromptSubmitted(input, invocation) {
      turnId += 1;
      pending = {
        prompt: input.prompt ?? "",
        ts: input.timestamp ?? new Date(),
        sessionId: invocation?.sessionId ?? "unknown",
        workingDirectory: input.workingDirectory ?? process.cwd(),
        id: turnId,
        agentMode: undefined,
        attachments: [],
      };
      lastAssistant = null;
      allMessages = [];
      capturedData = resetCapturedData();
    },

    onSessionEnd(_input) {
      // Final clean-up: if a turn was left pending (session ended before idle),
      // try to write whatever was captured.
      if (pending && lastAssistant) {
        const snap = { ...pending };
        const assistantSnap = lastAssistant;
        const allSnap = [...allMessages];
        const capturedSnap = { ...capturedData, attachments: [...capturedData.attachments], reasoning: [...capturedData.reasoning], tools: [...capturedData.tools], usage: [...capturedData.usage], model: [...capturedData.model], skills: [...capturedData.skills], subagents: [...capturedData.subagents], permissions: [...capturedData.permissions], errors: [...capturedData.errors], lifecycle: [...capturedData.lifecycle], turns: [...capturedData.turns], schedules: [...capturedData.schedules], notifications: [...capturedData.notifications] };
        pending = null;
        lastAssistant = null;
        allMessages = [];
        capturedData = resetCapturedData();
        flushOnce(snap, assistantSnap, allSnap, capturedSnap).catch((err) =>
          session.log(`copilot-cli-log-to-file: onSessionEnd flush failed: ${err.message}`, { level: "error" })
        );
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

// User message — capture attachments and agentMode
session.on("user.message", (event) => {
  if (!pending) return;
  const data = event?.data;
  if (data?.agentMode) pending.agentMode = data.agentMode;
  if (data?.attachments && data.attachments.length > 0) {
    pending.attachments = data.attachments.map((att) => ({
      type: att.type,
      path: att.path,
      displayName: att.displayName,
    }));
    capturedData.attachments.push(...pending.attachments);
  }
});

// Assistant reasoning
session.on("assistant.reasoning", (event) => {
  const content = event?.data?.content;
  if (content) {
    capturedData.reasoning.push({ content });
  }
});

// Tool execution start
session.on("tool.execution_start", (event) => {
  const data = event?.data;
  if (!data?.toolCallId) return;
  capturedData.tools.push({
    toolCallId: data.toolCallId,
    toolName: data.toolName,
    arguments: typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments),
    mcpServerName: data.mcpServer?.name,
    mcpToolName: data.mcpServer?.toolName,
    model: data.model,
  });
});

// Tool execution complete — correlate with start by toolCallId (first unresolved match)
session.on("tool.execution_complete", (event) => {
  const data = event?.data;
  if (!data?.toolCallId) return;
  // Find the first UNRESOLVED start with this toolCallId (no success field yet)
  const existing = capturedData.tools.find((t) => t.toolCallId === data.toolCallId && t.success === undefined);
  if (existing) {
    existing.success = data.success;
    existing.result = typeof data.result === "string" ? data.result : JSON.stringify(data.result);
    existing.error = data.error;
    existing.sandboxed = data.sandboxed;
    existing.isUserRequested = data.isUserRequested;
  } else {
    // Start event was missed; add result-only entry
    capturedData.tools.push({
      toolCallId: data.toolCallId,
      success: data.success,
      result: typeof data.result === "string" ? data.result : JSON.stringify(data.result),
      error: data.error,
    });
  }
});

// Assistant usage
session.on("assistant.usage", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.usage.push({
    model: data.model,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    cacheReadTokens: data.cacheReadTokens,
    cacheWriteTokens: data.cacheWriteTokens,
    cost: data.cost,
    duration: data.duration,
    finishReason: data.finishReason,
    apiCallId: data.apiCallId,
  });
});

// Model change
session.on("session.model_change", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.model.push({
    previousModel: data.previousModel,
    newModel: data.newModel,
    contextTier: data.contextTier,
    reasoningEffort: data.reasoningEffort,
    cause: data.cause,
  });
});

// Skill invoked
session.on("skill.invoked", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.skills.push({
    name: data.name,
    trigger: data.trigger,
    source: data.source,
  });
});

// Subagent started
session.on("subagent.started", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.subagents.push({
    agentId: data.agentId,
    agentName: data.agentName,
    status: "started",
  });
});

// Subagent completed
session.on("subagent.completed", (event) => {
  const data = event?.data;
  if (!data) return;
  const existing = capturedData.subagents.find((sa) => sa.agentId === data.agentId && sa.status === "started");
  if (existing) {
    existing.status = "completed";
    existing.summary = data.summary;
  } else {
    capturedData.subagents.push({
      agentId: data.agentId,
      status: "completed",
      summary: data.summary,
    });
  }
});

// Subagent failed
session.on("subagent.failed", (event) => {
  const data = event?.data;
  if (!data) return;
  const existing = capturedData.subagents.find((sa) => sa.agentId === data.agentId && sa.status === "started");
  if (existing) {
    existing.status = "failed";
    existing.error = data.error;
  } else {
    capturedData.subagents.push({
      agentId: data.agentId,
      status: "failed",
      error: data.error,
    });
  }
});

// Permission requested
session.on("permission.requested", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.permissions.push({
    requestId: data.requestId,
    type: "requested",
    // PermissionRequestedData has permissionRequest/promptRequest, not prompt.displayText
    permissionKind: data.permissionRequest?.kind,
    promptDisplayText: data.promptRequest?.displayText,
  });
});

// Permission completed
session.on("permission.completed", (event) => {
  const data = event?.data;
  if (!data) return;
  const existing = capturedData.permissions.find((p) => p.requestId === data.requestId && p.type === "requested");
  if (existing) {
    existing.type = "completed";
    existing.result = data.result?.type;
  } else {
    capturedData.permissions.push({
      requestId: data.requestId,
      type: "completed",
      result: data.result?.type,
    });
  }
});

// Errors
session.on("session.error", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.errors.push({
    errorType: data.errorType,
    message: data.message,
    errorCode: data.errorCode,
    statusCode: data.statusCode,
  });
});

// Model call failure
session.on("model.call_failure", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.errors.push({
    errorType: "model_call_failure",
    message: data.message,
    statusCode: data.statusCode,
    source: data.source,
  });
});

// Abort
session.on("abort", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.errors.push({
    errorType: "abort",
    reason: data.reason,
  });
});

// Lifecycle events
session.on("session.start", (event) => {
  const data = event?.data;
  if (!data) return;
  // StartData has contextTier, copilotVersion, reasoningEffort, but NOT sessionId or selectedModel.
  // sessionId is already in pending from the hook; model comes from assistant.usage or model.change.
  capturedData.lifecycle.push({
    event: "start",
    contextTier: data.contextTier,
    copilotVersion: data.copilotVersion,
    reasoningEffort: data.reasoningEffort,
  });
});

session.on("session.resume", (event) => {
  const data = event?.data;
  if (!data) return;
  // ResumeData has contextTier, eventCount, resumeTime, reasoningEffort, but NOT sessionId or selectedModel.
  capturedData.lifecycle.push({
    event: "resume",
    eventCount: data.eventCount,
    contextTier: data.contextTier,
    resumeTime: data.resumeTime,
    reasoningEffort: data.reasoningEffort,
  });
});

session.on("session.compaction_start", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.lifecycle.push({
    event: "compaction_start",
    conversationTokens: data.conversationTokens,
    systemTokens: data.systemTokens,
  });
});

session.on("session.compaction_complete", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.lifecycle.push({
    event: "compaction_complete",
    success: data.success,
    tokensRemoved: data.tokensRemoved,
    messagesRemoved: data.messagesRemoved,
    error: data.error,
  });
});

session.on("session.truncation", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.lifecycle.push({
    event: "truncation",
    messagesRemoved: data.messagesRemoved,
  });
});

session.on("session.context_changed", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.lifecycle.push({
    event: "context_changed",
    cwd: data.cwd,
    branch: data.branch,
    repository: data.repository,
  });
});

session.on("session.usage_info", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.lifecycle.push({
    event: "usage_info",
    currentTokens: data.currentTokens,
    tokenLimit: data.tokenLimit,
    messagesLength: data.messagesLength,
  });
});

session.on("session.todos_changed", (event) => {
  const data = event?.data;
  // Apply consistent guard pattern even though TodosChangedData has no fields
  capturedData.lifecycle.push({
    event: "todos_changed",
  });
});

session.on("session.plan_changed", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.lifecycle.push({
    event: "plan_changed",
    operation: data.operation,
  });
});

// Turn boundaries
session.on("assistant.turn_start", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.turns.push({
    event: "turn_start",
    turnId: data.turnId,
    interactionId: data.interactionId,
  });
});

session.on("assistant.turn_end", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.turns.push({
    event: "turn_end",
    turnId: data.turnId,
  });
});

// Schedules
session.on("session.schedule_created", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.schedules.push({
    event: "created",
    id: data.id,
    prompt: data.prompt,
    recurring: data.recurring,
    intervalMs: data.intervalMs,
    cron: data.cron,
  });
});

session.on("session.schedule_cancelled", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.schedules.push({
    event: "cancelled",
    id: data.id,
  });
});

session.on("session.autopilot_objective_changed", (event) => {
  const data = event?.data;
  if (!data) return;
  capturedData.schedules.push({
    event: "autopilot_objective_changed",
    operation: data.operation,
    status: data.status,
    id: data.id,
  });
});

// Notifications
session.on("system.notification", (event) => {
  const data = event?.data;
  if (!data) return;
  // SystemNotificationData has content (string) and kind (SystemNotification union), not notification
  capturedData.notifications.push({
    type: "system",
    content: data.content,
    kind: data.kind?.type,  // kind is a discriminated union with a 'type' field
  });
});

session.on("custom.notification", (event) => {
  const data = event?.data;
  if (!data) return;
  // CustomNotificationData has name, payload, source, version, not title/message
  capturedData.notifications.push({
    type: "custom",
    name: data.name,
    source: data.source,
    payload: data.payload,
  });
});

session.on("session.idle", async () => {
  if (!pending || !lastAssistant || lastAssistant.trim() === "") return;

  const snap = { ...pending };
  const assistantSnap = lastAssistant;
  const allSnap = [...allMessages];
  const capturedSnap = {
    attachments: [...capturedData.attachments],
    reasoning: [...capturedData.reasoning],
    tools: [...capturedData.tools],
    usage: [...capturedData.usage],
    model: [...capturedData.model],
    skills: [...capturedData.skills],
    subagents: [...capturedData.subagents],
    permissions: [...capturedData.permissions],
    errors: [...capturedData.errors],
    lifecycle: [...capturedData.lifecycle],
    turns: [...capturedData.turns],
    schedules: [...capturedData.schedules],
    notifications: [...capturedData.notifications],
  };

  // Clear before async work to prevent double-write
  pending = null;
  lastAssistant = null;
  allMessages = [];
  capturedData = resetCapturedData();

  await flushOnce(snap, assistantSnap, allSnap, capturedSnap);
});

// ─── Idempotency-guarded flush ────────────────────────────────────────────────

/**
 * Flush a turn at most once, even if both session.idle and onSessionEnd fire.
 * Sets flushedTurnId before the first await so concurrent calls are blocked.
 */
async function flushOnce(snapPending, assistant, all, captured) {
  if (!snapPending || !assistant || assistant.trim() === "") return;
  if (snapPending.id === flushedTurnId) return;
  flushedTurnId = snapPending.id;
  await flushLog(session, snapPending, assistant, all, captured);
}

// ─── Core write logic ─────────────────────────────────────────────────────────

/**
 * Write one log file for a completed turn.
 */
async function flushLog(session, snap, assistantContent, allMsgs, captured) {
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
    sessionId: snap.sessionId,
  });

  const ext = cfg.fileFormat === "txt" ? ".txt" : ".yaml";
  const patternHasExt = /\.(yaml|yml|txt)$/i.test(rawFilename);
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
      sessionId: snap.sessionId,
      prompt: snap.prompt,
      content: assistantContent,
      allMessages: allMsgs,
      capturedData: captured,
    },
    cfg.fileFormat,
    cfg.includeAllMessages,
    cfg
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
