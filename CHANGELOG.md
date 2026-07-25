# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-07-25

### Fixed

- **Pi could not start with this extension installed.** `setLabel` was called
  during module evaluation, which Pi rejects with
  `ExtensionRuntimeNotInitializedError` — and that aborts the whole agent, not
  just the extension. Calling it later did not help either: Pi's `setLabel`
  renames a session entry and throws `Entry ... not found`. The call is gone;
  the message box was titled by `customType` all along, so nothing is lost.

### Changed

- Settings are accepted under `PI_REFUSAL_*` as well as `OMP_REFUSAL_*`.
- The log now defaults to `~/.refusal-guard/refusals.jsonl` instead of a path
  under `~/.omp`, so it is not misleading on Pi. One log serves both harnesses.

## [0.2.0] - 2026-07-25

### Added

- Detect content blocks from providers other than Anthropic. Google
  (`promptFeedback.blockReason`) and OpenAI Responses (`incomplete:
  content_filter`) are recognised through omp's `ContentBlocked` error flag;
  OpenAI chat-completions reports `finish_reason: content_filter` with no flag,
  so that one is matched on the error text. These carry no provider category and
  are recorded as `content-blocked`.

### Changed

- Detection now requires `stopReason === "error"`, which every classifier
  decline already sets. Retarget remains Anthropic-only — `fallbacks` is a
  parameter of Anthropic's beta and has no equivalent elsewhere.

## [0.1.0] - 2026-07-25

### Added

- Rescue: a Claude safety-classifier refusal that produced no output and that no
  fallback recovered now gets one continuation carrying a reframing note,
  instead of ending the turn silently. A mid-stream refusal that already emitted
  text or a tool call is recorded and left alone, since re-prompting there risks
  duplicating work or stranding a tool call.
- The one-rescue guard is cleared by a turn that actually produces output rather
  than by a turn boundary, so a rescue continuation that opens its own turn
  cannot reset the guard and loop.
- Telemetry: refusals are appended to `~/.omp/refusal-guard.jsonl` with model,
  category, explanation and outcome (`fallback`, `rescued`, `partial`, `dead`).
- `/refusals` command reporting categories, models, outcomes and recent entries,
  with `on` / `off` / `clear` subcommands.
- Retarget: `OMP_REFUSAL_FALLBACKS` rewrites Anthropic's server-side `fallbacks`
  chain. Rewrite-only, so a chain is never sent without its beta header.
