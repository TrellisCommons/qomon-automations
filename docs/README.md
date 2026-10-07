---
last-reviewed: 2026-10-07
review-interval-days: 180
doc-memory-version: 4
---

# Docs are shared memory

This directory is the durable, shared memory of the repo: what the code cannot
say about itself, kept next to the code and changed through the same PR review
as the code. It exists because every collaborator, human or Claude agent,
starts from the same place: sessions are ephemeral, containers are thrown
away, and only what is committed persists. Knowledge that lives in one
person's head, one chat transcript, or one Slack thread is lost to everyone
else; knowledge that lives here is loaded on demand by whoever needs it.

Docs only work as memory if they are trustworthy, so this system forces two
things: **capture** (docs get updated when the code they cover changes) and
**review** (every doc gets re-verified against reality on a schedule). Neither
relies on anyone remembering to do it.

## The loop

1. **Load.** `CLAUDE.md` indexes the memory; an agent or a person reads only
   the docs the task needs. `docs/doc-map.tsv` says which docs cover which
   code areas.
2. **Work.** Normal development.
3. **Sync.** Changing code in a mapped area obliges a doc check. The **Doc
   Sync** PR check fails any pull request that changes a mapped area without
   touching its docs (the `docs-not-needed` label overrides it when a change
   genuinely has no doc impact), and the **doc-sync** skill gives the guided
   path: what is worth capturing, which doc it goes in, and in what style.
4. **Review.** Every memory doc carries `last-reviewed` and
   `review-interval-days` frontmatter. When a review is overdue, a weekly
   GitHub Action issue and `scripts/check-doc-freshness.sh` say so, and the
   **doc-review** skill walks the reviewer through re-verifying the doc claim
   by claim and bumping the date.

Capture is PR-scoped and event-driven; review is calendar-driven. Together
they bound how stale any doc can silently get. Capture is enforced at the PR,
not inside any one editor, deliberately: the merge gate is the one point every
change passes through, whether it came from a human, a Claude session, or any
other tool, and it is immune to edits that sidestep an editor's hooks (shell
commands, scripts, generators).

## Components

| Piece | Role |
|---|---|
| `CLAUDE.md` | Index and hard rules, loaded into every agent session. Kept lean; durable detail lives here in `docs/`. |
| `docs/doc-map.tsv` | Single source of truth mapping code areas to their docs. The check, the skills, and humans all read this one file. |
| `docs/<area>/*.md` | The memory itself, one directory per project area. |
| YAML frontmatter (`last-reviewed`, `review-interval-days`) | A doc's freshness contract. Opting a doc in is adding these two lines. |
| `scripts/check-doc-sync.sh` | The capture check: lists mapped areas changed on a branch without their docs; exit 1 when any. Runnable locally before pushing. |
| `.github/workflows/doc-sync-check.yml` | Runs the capture check on every PR (the **Doc Sync** check); the `docs-not-needed` label skips it. |
| `scripts/check-doc-freshness.sh` | Lists overdue docs; exit 1 when anything is overdue. Runnable by anyone, anywhere. |
| `.github/workflows/doc-freshness.yml` | Weekly check that opens or updates a `doc-review` issue listing overdue docs, so staleness stays visible without nagging every session. |
| `.claude/skills/doc-sync/` | Guided procedure for folding a code change into the docs. |
| `.claude/skills/doc-review/` | Guided procedure for a scheduled full review of one doc. |
| `AGENTS.md` (symlink to `CLAUDE.md`) | The same index for tools that read the vendor-neutral convention (Cursor, Copilot, Codex, and others). |

## The map

`docs/doc-map.tsv` has one rule per line, tab-separated:

```
<code globs, space-separated>	<doc path or glob>	<what to update>
```

A rule arms when a changed file matches any code glob, and is satisfied when
a changed file matches the doc path or glob. The third column is the hint
shown when the check fails. To change what is watched, edit the map; the
check and skills pick it up without modification.

## Freshness metadata

Every memory doc starts with:

```yaml
---
last-reviewed: 2026-10-07
review-interval-days: 90
---
```

Semantics, and the two rules that keep the date honest:

- `last-reviewed` is bumped **only** by a full review (the doc-review skill),
  in which every claim was confirmed, fixed, or flagged. A targeted doc-sync
  edit does not bump it: fixing one sentence says nothing about the other
  fifty.
- A review that changes nothing **still** bumps the date. The date records
  that verification happened, not that content changed.

Choosing an interval: fast-moving docs (open questions, unconfirmed vendor
facts) get 30 to 60 days; design docs get around 90; stable reference
(glossary, regulatory rules, decision logs) gets 180. Reviews may adjust the
interval, with a stated reason, as a doc's churn becomes clear.

## Living memory vs reference snapshots

Living docs (design, integrations, open questions) assert facts about the
present and must track it. Snapshots (for example vendor API specs) are
point-in-time artifacts: a review does not edit them, it
asks whether the snapshot is old enough to re-request from the source. Both
kinds carry freshness frontmatter; only the review action differs.

## Adding a new memory area

1. Create `docs/<area>/` with the doc(s). Prefer a few single-purpose docs
   over one long one, so sessions can load only what a task needs.
2. Add frontmatter to each doc with today's date and a chosen interval.
3. Add a rule to `docs/doc-map.tsv` mapping the code area to the docs.
4. Add the area to the knowledge-base section of `CLAUDE.md`, one line per
   doc saying when to load it.

The checks, skills, and workflows need no changes.

## What belongs in memory docs

Capture what the code cannot say and a future session would otherwise
rediscover the hard way: decisions and their why, domain rules, external and
vendor facts, constraints and invariants, known risks, and open questions.
Do not capture what the code already says (narrated implementations go stale
the moment the code moves), transient status better suited to an issue or PR,
or secrets and credentials of any kind.

## Writing conventions

Concise and factual. Canadian spelling, Oxford comma, no em-dashes, no
horizontal rule directly above a header. Text-based formats only: Markdown,
Mermaid, CSV/TSV. Write for a reader with zero session context, and link to
sources (Drive doc ids, spec files, handbook sections) so claims can be
re-verified later.

Link on first mention. The first time a doc names a domain term, link the
glossary entry; the first time it leans on a decision, link the decision log
entry; the first time it touches another doc's subject, link that doc. Use
repo-relative paths. One link at first mention is enough; do not re-link
every occurrence. Links are how a reader, human or agent, traverses the
memory without searching it.

Date external facts. A claim about an external system, vendor, or rule
carries the date it was last observed true ("as of 2026-06") and its source.
`last-reviewed` records when a whole doc was verified; an as-of date records
when a single fact was. Re-verifying a claim against its source refreshes its
date, and when two versions of the same fact meet, the as-of dates say which
one is current.

## Origin

This system was copied from `gpo/gpo-monolith` (an install of the
**doc-memory** skill bundle, stamped with `doc-memory-version` in this file's
frontmatter). When the bundle evolves past this stamp, the update-doc-memory
skill brings this install up to date.
