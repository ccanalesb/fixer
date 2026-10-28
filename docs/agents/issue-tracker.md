# Issue Tracker

Issues are tracked in GitHub Issues for Fixer: `ccanalesb/fixer` (GitHub repo name unchanged until the owner renames it).

## Workflow

- Use the `gh` CLI for all issue operations
- Create: `gh issue create --title "..." --body "..."`
- List: `gh issue list`
- View: `gh issue view <number>`
- Close: `gh issue close <number>`

## Labels

Apply triage labels via `gh issue edit <number> --add-label "<label>"`.

See `docs/agents/triage-labels.md` for the canonical label vocabulary.

## Conventions

- One issue per bug or feature
- Link PRs to issues with `Closes #<number>` in the PR body
- Use issue comments for status updates rather than editing the body

## PRD lifecycle

Issues progress from raw idea → grilled PRD → ready to implement. The title prefix signals the state:

- **No prefix** — an ungrilled idea/seed. The body is a short stub and is not yet implementation-ready.
- **`[PRD]` prefix** — the issue has been grilled (e.g. via `/grill-with-docs`) into a full PRD body. A PRD is a **spec, not a task**: it is broken into implementation issues (via `/to-issues`) rather than built directly. Add the prefix **only** once the body has the PRD shape (Problem / Goal or Solution / Scope / Acceptance criteria / Out of scope).

Rules:

- Adding `[PRD]` and the PRD-shaped body go together — don't prefix a thin stub.
- Editing an issue body to author/refine its PRD is expected and is **not** a "status update" (the comments-not-body convention above applies to status, not to PRD authoring).
- When you migrate a backlog/seed item into its own issue, leave it unprefixed until it's grilled.

## `ready-for-agent` and Sandcastle

**`ready-for-agent` is the Sandcastle trigger.** Adding it to an issue (see `.github/workflows/sandcastle.yml`) fires an AFK agent that implements the issue and opens a PR. Treat the label as "build this now," not merely "specified."

Consequences:

- **Never put `ready-for-agent` on a `[PRD]` issue.** A PRD is a spec — labeling it makes Sandcastle try to build the whole PRD in one PR. As a safeguard, Sandcastle also skips any issue whose title starts with `[PRD]`, but don't rely on that: keep PRDs unlabeled.
- **Sandcastle has no dependency awareness.** It fires immediately on the label and ignores an issue's "Blocked by" section. So label **one unblocked slice at a time** — add `ready-for-agent` to the next slice only after its blocker's PR has merged. Labeling a whole dependency chain at once runs every slice in parallel, out of order.

## Wayfinding operations

The `/wayfinder` skill plans large, foggy efforts as a **map** of decision **tickets** on this tracker. GitHub (via `gh`) has no native sub-issue or blocking commands here, so these relationships use **body conventions**:

- **Map** — one issue labelled `wayfinder:map`. Its body is the low-res view (Destination / Notes / Decisions so far / Not yet specified / Out of scope). Open tickets are *not* listed in the body; they are found by query.
- **Ticket** — a child issue labelled `wayfinder:ticket` plus a type label (`wayfinder:research` | `wayfinder:prototype` | `wayfinder:grilling` | `wayfinder:task`). Its body has a `## Question` and a `Part of #<map>` line linking the map.
- **Blocking** — a `## Blocked by` section listing `#<n>` of each blocker. A ticket is **unblocked** when every issue it lists is closed.
- **Claim** — assign the ticket to the driving dev *before* any work. An open, unassigned ticket is unclaimed.
- **Frontier query** — open `wayfinder:ticket` issues that are unassigned and fully unblocked:

  ```
  gh issue list --label "wayfinder:ticket" --state open --json number,title,assignees,body
  ```

  then keep those with no assignee whose every `## Blocked by` `#<n>` is closed.
- **Resolve** — post the answer as a comment, close the issue, and append a one-line pointer to the map's "Decisions so far". Never resolve more than one ticket per session.
- **Do not** put `ready-for-agent` on wayfinder issues — they are planning artifacts, not build tasks.
