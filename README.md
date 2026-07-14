# copilot-cli-log-to-file

A **GitHub Copilot CLI extension** that logs every final assistant response to a timestamped file. Both the output folder and the filename pattern are fully configurable.

## NEW: Enriched Capture (v0.2.0)

This extension now captures **much more detail per turn** beyond just the prompt and response — all **opt-in** and individually toggleable:

- **Attachments** — files, selections, directories attached to the prompt  
- **Reasoning** — model's explicit reasoning content  
- **Tool calls & results** — what tools were called, with what arguments, and their outcomes  
- **Token usage & cost** — input/output/cache tokens, duration, model, finishReason, cost  
- **Model info** — model changes, context tier, reasoning effort  
- **Skills** — which skills were invoked  
- **Subagents** — subagent lifecycle (started, completed, failed)  
- **Permissions** — what permission requests were made and their results  
- **Errors** — errors, model call failures, aborts  
- **Lifecycle** — session start/resume, compaction, truncation, context changes, usage_info  
- **Turns** — turn boundaries (start/end)  
- **Schedules** — scheduled prompts (`/every`, `/after`), autopilot objectives  
- **Notifications** — system and custom notifications  

**Default**: all OFF. You opt into what you need via config or env vars. Without any captures enabled, the output is identical to v0.1 — just `timestamp`, `sessionId`, `prompt`, `response`.

---

## What it does

For every Copilot CLI prompt/turn, after the assistant finishes responding, the extension writes the full response (plus prompt + metadata) to a file. Files are named by timestamp and prompt text by default, e.g.:

```
copilot-response-log/
  2026-07-13T11-21-45Z-list-all-my-files.yaml
  2026-07-13T14-05-02Z-explain-this-function.yaml
```

---

## Installation

There are two ways to install this extension.

### A) Project-scoped (works only in one repo)

Copy the `copilot-cli-log-to-file` folder into the target repo's `.github/extensions/` directory:

```
your-repo/
  .github/
    extensions/
      copilot-cli-log-to-file/
        extension.mjs
        lib/
          format.mjs
```

The Copilot CLI discovers extensions at `.github/extensions/<name>/extension.mjs` relative to the git root.

### B) User-scoped (applies to ALL repos)

Copy the `copilot-cli-log-to-file` folder into the Copilot CLI user config extensions directory (persists across all repos). The exact path is shown in `gh copilot config` or the CLI docs.

### After installing

Reload with `extensions_reload` or restart the CLI for the extension to take effect.

---

## Configuration

Config is loaded with this precedence (later overrides earlier):

1. Built-in defaults
2. `config.json` placed next to `extension.mjs` (copy `config.example.json` → `config.json`)
3. Environment variables (highest precedence)

### Core settings

| Field | Default | Env var | Description |
|---|---|---|---|
| `outputDir` | `"copilot-response-log"` | `COPILOT_LOG_DIR` | Output folder. Relative paths are resolved from the session working directory. Absolute paths used as-is. |
| `filenamePattern` | `"{timestamp}-{prompt30}.yaml"` | `COPILOT_LOG_FILENAME_PATTERN` | Filename pattern with tokens (see below). |
| `includeAllMessages` | `false` | `COPILOT_LOG_INCLUDE_ALL` (`"true"`/`"false"`) | Include all intermediate assistant messages, not just the final one. |
| `fileFormat` | `"yaml"` | `COPILOT_LOG_FORMAT` (`"yaml"` or `"txt"`) | Output format: complete YAML document (machine-parseable), or plain text. Legacy value `"md"` is silently treated as `"yaml"`. |

### Capture toggles (all **default OFF**)

Add a `capture` object in `config.json` or use env vars to enable individual categories:

```json
{
  "capture": {
    "attachments": false,
    "reasoning": false,
    "toolCalls": false,
    "toolResults": false,
    "usage": false,
    "model": false,
    "skills": false,
    "subagents": false,
    "permissions": false,
    "errors": false,
    "lifecycle": false,
    "turns": false,
    "schedules": false,
    "notifications": false
  }
}
```

| Capture | Env var | What it captures |
|---|---|---|
| `attachments` | `COPILOT_LOG_CAPTURE_ATTACHMENTS` | Files, directories, selections attached to the user message |
| `reasoning` | `COPILOT_LOG_CAPTURE_REASONING` | Model's explicit reasoning content (`assistant.reasoning` events) |
| `toolCalls` | `COPILOT_LOG_CAPTURE_TOOLCALLS` | Tool execution starts — name, arguments, mcpServer, model |
| `toolResults` | `COPILOT_LOG_CAPTURE_TOOLRESULTS` | Tool execution complete — success, result, error |
| `usage` | `COPILOT_LOG_CAPTURE_USAGE` | Token usage per model call — input/output/cache tokens, cost, duration, finishReason |
| `model` | `COPILOT_LOG_CAPTURE_MODEL` | Model changes — previous/new model, contextTier, reasoningEffort, cause |
| `skills` | `COPILOT_LOG_CAPTURE_SKILLS` | Skill invocations — name, trigger, source |
| `subagents` | `COPILOT_LOG_CAPTURE_SUBAGENTS` | Subagent lifecycle — started, completed, failed, agentId, agentName, summary, error |
| `permissions` | `COPILOT_LOG_CAPTURE_PERMISSIONS` | Permission requests and results — requestId, prompt, result |
| `errors` | `COPILOT_LOG_CAPTURE_ERRORS` | Errors — session.error, model.call_failure, abort events |
| `lifecycle` | `COPILOT_LOG_CAPTURE_LIFECYCLE` | Session lifecycle — start, resume, compaction, truncation, context_changed, usage_info, todos/plan changes |
| `turns` | `COPILOT_LOG_CAPTURE_TURNS` | Turn boundaries — turn_start, turn_end, turnId, interactionId |
| `schedules` | `COPILOT_LOG_CAPTURE_SCHEDULES` | Scheduled prompts (`/every`, `/after`) and autopilot objectives |
| `notifications` | `COPILOT_LOG_CAPTURE_NOTIFICATIONS` | System and custom notifications |

**Master override**: Set `COPILOT_LOG_CAPTURE_ALL=true` to enable **all** capture toggles at once (config.json values ignored).

**Conservative default**: With **no** captures enabled (default), output is identical to v0.1 — only `timestamp`, `sessionId`, `prompt`, `response` (+ optional `messages`) are written.

### Filename tokens

| Token | Description |
|---|---|
| `{timestamp}` | ISO 8601 of capture time, filesystem-safe. Colons → dashes, milliseconds dropped. E.g. `2026-07-13T11-21-45Z` |
| `{prompt30}` | First 30 chars of the prompt, slugified (whitespace collapsed, illegal chars stripped, spaces → `-`, lowercased). E.g. `list-all-my-files` |
| `{promptSlug}` | Same as `{prompt30}` but full-length (capped at ~80 chars). |
| `{sessionId}` | First 8 chars of the Copilot session ID. |

Filename safety: path separators and Windows-illegal chars (`< > : " / \ | ? *`) are always stripped from the final filename. Total filename length is capped at 180 chars. If a file with the same name already exists, `-2`, `-3`, etc. are appended.

### Example: enable usage + tools + errors

**Via config.json:**

```json
{
  "outputDir": "copilot-response-log",
  "filenamePattern": "{timestamp}-{prompt30}.yaml",
  "capture": {
    "usage": true,
    "toolCalls": true,
    "toolResults": true,
    "errors": true
  }
}
```

**Via env vars:**

```bash
export COPILOT_LOG_CAPTURE_USAGE=true
export COPILOT_LOG_CAPTURE_TOOLCALLS=true
export COPILOT_LOG_CAPTURE_TOOLRESULTS=true
export COPILOT_LOG_CAPTURE_ERRORS=true
```

**Enable everything:**

```bash
export COPILOT_LOG_CAPTURE_ALL=true
```

---

## File content (YAML format — default)

Each log file is a **complete, valid YAML document** — no frontmatter wrapper, no Markdown body. It can be loaded by any YAML parser directly.

### Minimal output (no captures enabled — default)

```yaml
timestamp: "2026-07-13T11:21:45.000Z"
sessionId: "abcdef1234567890"
prompt: |-
  List all my files
response: |-
  Here are your files: ...
```

### Enriched output (with captures enabled)

When you enable capture toggles, additional top-level YAML sections appear **only when there is data for that category**:

```yaml
timestamp: "2026-07-14T10:00:00.000Z"
sessionId: "test1234"
prompt: |-
  Find all TODO comments in the codebase
attachments:
  - type: "file"
    path: "/workspace/src/main.ts"
    displayName: "main.ts"
reasoning:
  - |-
    I'll use grep to search for TODO comments across all source files...
tools:
  - toolCallId: "call_abc123"
    toolName: "grep"
    arguments: '{"pattern":"TODO","glob":"**/*.ts"}'
    success: true
    result: "Found 12 matches"
usage:
  - model: "gpt-5"
    inputTokens: 1200
    outputTokens: 450
    cacheReadTokens: 800
    cacheWriteTokens: 0
    duration: 1250
    finishReason: "stop"
    apiCallId: "req_xyz789"
response: |-
  I found 12 TODO comments across your TypeScript files: ...
```

All sections are **stable-ordered** and follow the same structure:

- Attachments, reasoning, tools, skills, subagents, permissions, errors, lifecycle, turns, schedules, notifications: **sequences** (arrays)
- Usage, model: **sequences of mappings**
- Each item is emitted as valid YAML with proper indentation

Multi-line string values use `|-` literal block scalars. Primitive values (numbers, booleans, short strings) are double-quoted or emitted as-is for safe parsing.

With `includeAllMessages: true`, a `messages` sequence is emitted between `prompt` and `response` (unchanged from v0.1):

```yaml
timestamp: "2026-07-13T11:21:45.000Z"
sessionId: "abcdef1234567890"
prompt: |-
  Explain this function
messages:
  - |-
    First partial answer...
  - |-
    Here is the full explanation...
response: |-
  Here is the full explanation...
```

### txt format

For `fileFormat: "txt"`, the output is plain text with separator lines. Captured sections are appended after the response in readable form (JSON-formatted for structured data):

```
timestamp: 2026-07-14T10:00:00.000Z
sessionId: test1234
prompt:
Find all TODO comments in the codebase
────────────────────────────────────────────────────────────
I found 12 TODO comments across your TypeScript files: ...

────────────────────────────────────────────────────────────
Attachments
────────────────────────────────────────────────────────────

[Attachment 1] file: main.ts

────────────────────────────────────────────────────────────
Tools
────────────────────────────────────────────────────────────

[Tool 1] grep (call_abc123)
Arguments: {"pattern":"TODO","glob":"**/*.ts"}
Success: true
Result: Found 12 matches

────────────────────────────────────────────────────────────
Usage
────────────────────────────────────────────────────────────

[Usage 1]
{
  "model": "gpt-5",
  "inputTokens": 1200,
  "outputTokens": 450,
  ...
}
```

---

## Running tests

`npm install` is required for `test/yaml.test.mjs` and `test/capture.test.mjs` (installs `js-yaml` as a devDependency). The other test files have no dependencies.

```bash
npm install
node test/yaml.test.mjs      # YAML round-trip validity (79 assertions, adversarial inputs)
node test/config.test.mjs    # loadConfig, buildFileContent, resolveOutputDir (44 assertions)
node test/tokens.test.mjs    # sanitizePrompt, formatTimestamp, substituteTokens, sanitizeFilename, resolveCollision (22 assertions)
node test/capture.test.mjs   # Capture toggles, env precedence, enriched YAML (74 assertions)
```

**Total: 219 assertions across 4 test files, all passing ✓**

---

## SDK note

`@github/copilot-sdk` is **not** an npm dependency. It is provided by the Copilot CLI at runtime and only resolves when run inside the CLI.

`js-yaml` is a **dev-only** dependency used exclusively by the test suite. It is not required at runtime — the extension itself contains a hand-rolled YAML emitter.

## console.log() is forbidden

stdout is reserved for the CLI's JSON-RPC protocol. **Never use `console.log()`** inside an extension. Use `session.log(message, { level })` for all user-visible output. This extension follows that rule throughout.

---

## Project structure

```
.github/extensions/copilot-cli-log-to-file/
  extension.mjs         # Entry point — joinSession + hooks + event handlers
  lib/
    format.mjs          # Pure helpers (config, token substitution, sanitizers, YAML emitter)
  config.example.json   # Documented config template

test/
  yaml.test.mjs         # YAML round-trip tests (js-yaml parser, adversarial inputs)
  tokens.test.mjs       # Tests for sanitizePrompt, formatTimestamp, substituteTokens, sanitizeFilename, resolveCollision
  config.test.mjs       # Tests for loadConfig, buildFileContent, resolveOutputDir
  capture.test.mjs      # Tests for capture toggles, env overrides, enriched YAML output

package.json
LICENSE
.gitignore
```

---

## License

MIT © 2026 Dina Berry
