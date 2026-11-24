# Changelog

All notable changes are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.3] - 2026-11-24

### Changed

- `suggest` no longer adds a note when a suggested shell rule has an option between the command and its subcommand, such as `git -C app *`. The note about nearby ask and deny rules stays.

## [0.1.2] - 2026-11-23

### Added

- Decision models as reviewers. Set `judge.modality` to `"decision"` and the plugin asks a model that scores yes/no questions, such as `typesafe/jev-1.14`, instead of one that writes an answer. It allows at a probability of 0.5 or above, and the audit log records the probability as the reason.
- An `eval/` README with results for 20 models.

### Changed

- **Breaking:** `judge.provider` is required and replaces `judge.apiStyle`. Use `"openrouter"`, which needs only `judge.model`, or `"openai-compatible"` with a `judge.baseURL` for any other chat completions server. The old `apiStyle` is still read as an alias for now.
- The reviewer allows or denies. A denied request goes back to the agent with the reason, and after five denies in a row (`judge.escalateAfter`) you are asked. An allow starts the count again.
- Every reason the reviewer gives is written to the audit log.
- Eval results are stored per provider, and the eval reports speak of requests that were wrongly allowed or wrongly denied.
- The source is grouped into `judge`, `audit` and `suggest` folders.

## [0.1.1] - 2026-11-22

### Changed

- `suggest` prints a table, the options are regrouped, and the README is rewritten.
- The `unattended` command alias is gone. Use `opencode-unattended`.

## [0.1.0] - 2026-11-22

First release. A reviewer model answers OpenCode permission requests so the agent keeps working while you are away. It comes with a monthly audit log, `stats` and `suggest` commands for finding allow rules, and an `opencode-unattended` CLI.

[Unreleased]: https://github.com/st3v3nmw/opencode-unattended/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/st3v3nmw/opencode-unattended/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/st3v3nmw/opencode-unattended/releases/tag/v0.1.2
[0.1.1]: https://github.com/st3v3nmw/opencode-unattended/releases/tag/v0.1.1
[0.1.0]: https://github.com/st3v3nmw/opencode-unattended/releases/tag/v0.1.0
