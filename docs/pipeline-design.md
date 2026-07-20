# Portable personal context pipeline design

This repo now owns both the capture layer and the first candidate-extraction step for portable personal context.

## Scope

Built now:

- Candidate extraction from `copilot-response-log/*.yaml`
- Candidate review YAML emission with every candidate set to `status: pending`
- A small CLI entry point and tests

Designed only:

- Ratification PR wiring
- Context repo publishing

## Data flow

```text
observation → candidate → ratification gate → context
YAML logs      review YAML  human PR decision   markdown rules
```

1. **Observation**: the Copilot CLI extension writes one timestamped YAML capture per turn. The current capture shape is a YAML mapping with `timestamp`, `sessionId`, `prompt`, optional `messages`, and `response`. Future enriched fields can be present, but extraction treats them as evidence context, not authority.
2. **Candidate**: extraction reads a time window, groups repeated signals, and writes proposed facts into a review YAML file.
3. **Ratification gate**: a human edits the review YAML in a PR, marking each candidate approved, rejected, or refined.
4. **Context**: approved or refined candidates become markdown rules in the portable context repo.

## Candidate extraction algorithm

The extractor is deterministic and conservative:

- Reads `.yaml` and `.yml` files from an input directory, defaulting to `copilot-response-log/`.
- Applies a window ending at extraction time, defaulting to the last seven days.
- Parses the real capture-layer YAML shape emitted by `lib/format.mjs`: `timestamp`, `sessionId`, `prompt`, optional `messages`, and `response`.
- Ignores unknown future/enriched blocks unless a later version explicitly promotes them to supported evidence.
- Emits candidates only when a signal repeats at least `--min-count` times, defaulting to 2, and spans enough session evidence to reduce one-off noise.

Current signal families:

- Repeated validation workflow language, such as targeted validation before broader/full-suite validation.
- Repeated command/tooling usage, such as the same `npm`, `node`, `git`, or `gh` command appearing across captures.
- Repeated explicit user-stated directives in prompts, limited to preference words such as "always", "never", "prefer", "use", "avoid", "must", and "should".

The extractor does **not** decide truth. It proposes candidates with frequency, session, source-file, and quote evidence so a person can decide.

## Evidence sources

YAML capture files remain the default source. The CLI can also read Copilot CLI `/chronicle` as an additive source with `--source chronicle` or `--source both`.

Chronicle support opens `%USERPROFILE%\.copilot\session-store.db` read-only through Node's built-in experimental `node:sqlite` module. If the runtime does not provide `node:sqlite`, or the store is not present, extraction records a notice and continues with any available YAML evidence instead of crashing. This keeps the repo free of runtime npm dependencies while making chronicle evidence available on supported Node versions.

Chronicle `turns` rows normalize to the same internal observation shape as capture YAML:

- `timestamp`
- `sessionId`
- `prompt` from `turns.user_message`
- `response` from `turns.assistant_response`
- optional file, ref, and usage evidence from `session_files`, `session_refs`, and `assistant_usage_events`

The window filter compares the first 10 characters of chronicle timestamps to avoid problems across SQLite text timestamp formats. When `--source both` is used, duplicated turns are de-duped before aggregation.

## Deduplication and confidence

Candidates are grouped by normalized signal keys:

- Commands collapse whitespace and normalize obvious absolute Windows paths to `<path>`.
- Explicit directives are lowercased and whitespace-normalized.
- Workflow signals use a fixed semantic key.

Confidence is only a triage signal:

- `high`: at least five observations across at least three sessions.
- `medium`: at least three observations, or at least two sessions.
- `low`: repeated enough to be listed, but still weak.

## Guardrails against bad promotion

The pipeline avoids auto-promotion by design:

- One-off observations are filtered out.
- Assistant responses alone never become canonical context.
- Prompt-injection text remains only a candidate unless repeated and human-approved.
- Every candidate starts as `status: pending`.
- Extraction never writes to the context repo and never mutates existing context.
- Evidence includes source file references so reviewers can inspect the raw observations.

## Candidate review YAML schema

Extraction emits a review artifact like:

```yaml
generated_at: "2026-07-20T19:43:08.000Z"
source_log_dir: "C:\\path\\to\\copilot-response-log"
window:
  since: "2026-07-13T19:43:08.000Z"
  until: "2026-07-20T19:43:08.000Z"
instructions: |-
  Edit status to approved, rejected, or refined. If refined, set refined_fact.
candidates:
  - id: "cand-001-targeted-validation"
    proposed_fact: |-
      You often prefer targeted validation before broader or full-suite validation.
    category: "workflow-preference"
    target_file: "context/workflow.md"
    confidence: "medium"
    status: "pending"
    approve: false
    reject: false
    refined_fact: ""
    reviewer_notes: ""
    evidence:
      - source: "copilot-response-log\\2026-07-20T12-00-00Z-example.yaml"
        timestamp: "2026-07-20T19:00:00.000Z"
        sessionId: "abc123"
        count: 1
        quote: |-
          Run targeted validation before the full suite.
```

Human-owned fields:

- `status`: `pending`, `approved`, `rejected`, or `refined`
- `approve`: optional boolean convenience flag
- `reject`: optional boolean convenience flag
- `refined_fact`: replacement text when the reviewer wants a more precise rule
- `reviewer_notes`: reviewer rationale

Machine-owned fields:

- `id`
- `proposed_fact`
- `category`
- `target_file`
- `confidence`
- `evidence`

## Ratification via PR

Designed-only flow:

1. A scheduled or manual extraction run creates a branch with a candidate review YAML file.
2. The branch opens a PR containing only the review artifact.
3. The human reviewer edits each candidate:
   - approve as written,
   - reject,
   - or refine with `refined_fact`.
4. Merge of the PR is the approval event. There is no approval outside source control.

This keeps the ratification gate visible, diffable, and reversible.

## Context repo publishing

Designed-only flow:

1. A publisher reads merged review YAML files.
2. It selects only `approved` candidates, plus `refined` candidates with `refined_fact`.
3. It writes or updates markdown rule files based on `target_file`.
4. It includes source review IDs and evidence links for auditability.

Publishing should be a separate PR so a context change is distinct from candidate review.

## Relationship to Copilot CLI Memory

This is not a duplicate of Copilot CLI Memory. The pipeline is vendor-neutral and portable across AI surfaces, stores file-owned inspectable evidence, and requires a strict no-auto-promotion human gate before context becomes canonical. Copilot Memory is single-vendor, provider-hosted, and closer to store-now/downvote-later; this pipeline is evidence-first and approve-before-publish.

## Relationship to Copilot CLI /chronicle

`/chronicle` has real overlap with this project. It already keeps a local raw session feed and provides retrospective insights/search across Copilot surfaces, so it overlaps both our capture layer and the "read a week of sessions to surface patterns" side of extraction.

The capture layer's remaining edge is human-owned plain files and portability beyond Copilot surfaces. The pipeline's stronger distinction is what `/chronicle` does not do: a ratification gate that promotes reviewed candidates into a canonical, vendor-neutral portable rules corpus. Chronicle can be an evidence source; it is not the canonical context publisher.
