# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-25

### Added

- Rescue: a Claude safety-classifier refusal that no fallback recovered now gets
  one continuation carrying a reframing note, instead of ending the turn with no
  output.
- Telemetry: refusals are appended to `~/.omp/refusal-guard.jsonl` with model,
  category, explanation and outcome (`fallback`, `rescued`, or `dead`).
- `/refusals` command reporting categories, models, outcomes and recent entries,
  with `on` / `off` / `clear` subcommands.
- Retarget: `OMP_REFUSAL_FALLBACKS` rewrites Anthropic's server-side `fallbacks`
  chain. Rewrite-only, so a chain is never sent without its beta header.
