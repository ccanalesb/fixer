# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `ccanalesb/lightroom-tagger` via the `gh` CLI. External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage vocabulary using the default label names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), all present on the GitHub repo. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT-MAP.md` at the root points to `apps/visualizer/CONTEXT.md`, which covers the whole product — API, CLI, jobs and UI. See `docs/agents/domain.md`.

## No provenance in code

Code, tests, scripts and the text they show say what is true now, not where it came from. No issue or PR numbers (`#339`), no research tickets (`ticket 15`), no research recipe names, run files or numbers. A comment states a constraint the code cannot show; a test title states the behaviour. Provenance goes in the commit message and the PR. ADR references (`ADR-0018`) are fine: they are current docs in this repo.
