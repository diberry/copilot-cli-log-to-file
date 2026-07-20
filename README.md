# copilot-cli-log-to-file

A **GitHub Copilot CLI extension** that logs every final assistant response to a timestamped file. Both the output folder and the filename pattern are fully configurable.

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

| Field | Default | Env var | Description |
|---|---|---|---|
| `outputDir` | `"copilot-response-log"` | `COPILOT_LOG_DIR` | Output folder. Relative paths are resolved from the session working directory. Absolute paths used as-is. |
| `filenamePattern` | `"{timestamp}-{prompt30}.yaml"` | `COPILOT_LOG_FILENAME_PATTERN` | Filename pattern with tokens (see below). |
| `includeAllMessages` | `false` | `COPILOT_LOG_INCLUDE_ALL` (`"true"`/`"false"`) | Include all intermediate assistant messages, not just the final one. |
| `fileFormat` | `"yaml"` | `COPILOT_LOG_FORMAT` (`"yaml"` or `"txt"`) | Output format: complete YAML document (machine-parseable), or plain text. Legacy value `"md"` is silently treated as `"yaml"`. |

### Filename tokens

| Token | Description |
|---|---|
| `{timestamp}` | ISO 8601 of capture time, filesystem-safe. Colons → dashes, milliseconds dropped. E.g. `2026-07-13T11-21-45Z` |
| `{prompt30}` | First 30 chars of the prompt, slugified (whitespace collapsed, illegal chars stripped, spaces → `-`, lowercased). E.g. `list-all-my-files` |
| `{promptSlug}` | Same as `{prompt30}` but full-length (capped at ~80 chars). |
| `{sessionId}` | First 8 chars of the Copilot session ID. |

Filename safety: path separators and Windows-illegal chars (`< > : " / \ | ? *`) are always stripped from the final filename. Total filename length is capped at 180 chars. If a file with the same name already exists, `-2`, `-3`, etc. are appended.

### Example: point logs at a project folder

```bash
export COPILOT_LOG_DIR="projects/project-dina/response-log"
export COPILOT_LOG_FILENAME_PATTERN="{timestamp}-{sessionId}-{prompt30}.yaml"
```

Or in `config.json`:

```json
{
  "outputDir": "projects/project-dina/response-log",
  "filenamePattern": "{timestamp}-{sessionId}-{prompt30}.yaml",
  "includeAllMessages": false,
  "fileFormat": "yaml"
}
```

---

## File content (YAML format — default)

Each log file is a **complete, valid YAML document** — no frontmatter wrapper, no Markdown body. It can be loaded by any YAML parser directly.

```yaml
timestamp: "2026-07-13T11:21:45.000Z"
sessionId: "abcdef1234567890"
prompt: |-
  List all my files
response: |-
  Here are your files: ...
```

With `includeAllMessages: true`, a `messages` sequence is emitted between `prompt` and `response`:

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

Multi-line values (prompt, response, messages) use `|-` literal block scalars so colons, hashes, quotes, tabs, backslashes, and unicode are all preserved as-is without escaping.

For `fileFormat: "txt"`:

```
timestamp: 2026-07-13T11:21:45.000Z
sessionId: abcdef1234567890
prompt:
List all my files
────────────────────────────────────────────────────────────
Here are your files: ...
```

---

## Running tests

`npm install` is required for `test/yaml.test.mjs` (installs `js-yaml` as a devDependency). The other test files have no dependencies.

```bash
npm install
npm test

# Or run individual tests:
node test/yaml.test.mjs     # YAML round-trip validity (35 assertions, adversarial inputs)
node test/config.test.mjs   # loadConfig, buildFileContent, resolveOutputDir (44 assertions)
node test/tokens.test.mjs   # sanitizePrompt, formatTimestamp, substituteTokens, sanitizeFilename, resolveCollision (22 assertions)
node test/extract.test.mjs  # candidate extraction and review YAML validity
```

---

## Candidate extraction

The capture layer is the observation stage for portable personal context. Candidate extraction reads a time window of capture YAML files and emits a human-reviewable YAML artifact. It does **not** approve, publish, or mutate context.

```bash
npm run extract:candidates -- --input copilot-response-log --days 7 --output candidate-review.yaml
```

Every emitted candidate starts with `status: pending`. See `docs/pipeline-design.md` for the observation → candidate → ratification → context design.

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

package.json
LICENSE
.gitignore
```

---

## License

MIT © 2026 Dina Berry
