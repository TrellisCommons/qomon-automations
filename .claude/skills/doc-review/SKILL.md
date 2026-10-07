---
name: doc-review
description: Run a scheduled freshness review of one memory doc against the current repo, then bump its last-reviewed date. Use when the doc-freshness issue or scripts/check-doc-freshness.sh reports a doc overdue, or when asked to review a doc.
---

# doc-review: verify a memory doc against reality

Memory docs decay: code moves on, vendors ship, rules change. A review walks
one doc claim by claim and either confirms, fixes, or flags each one, then
bumps `last-reviewed` so the freshness system knows it was done. See
`docs/README.md` for the system this belongs to.

## Steps

1. **Pick the doc.** If none was named, run `scripts/check-doc-freshness.sh`
   and take the most overdue one. Review one doc per pass; small and complete
   beats broad and shallow.
2. **Establish the doc's sources of truth.** From `docs/doc-map.tsv`, find the
   code areas the doc covers. Note which claims are verifiable from the repo
   and which rest on external sources (vendor docs, Elections Ontario
   guidance, Drive documents, Slack).
3. **Verify claim by claim.** For each factual claim, path, command, and
   cross-reference in the doc:
   - **confirmed** → leave it; a dated external fact re-verified against its
     source gets its as-of date refreshed;
   - **stale** → fix it (repo-verifiable claims: check the code, run the
     command; do not guess);
   - **unverifiable from the repo** → leave it, but if it looks doubtful, add
     it to `open-questions.md` with what would confirm it.
   Claims are not independent: also compare them to each other. Two claims
   about the same fact (often an appended update sitting beside the sentence
   it should have replaced) are the failure this system exists to prevent,
   and this comparison holds even when both claims are individually
   unverifiable. Collapse them into one current claim, stated once, where a
   reader would look for it; the as-of dates say which is newer. If you
   cannot tell whether the difference is a correction or a genuine change
   over time, keep the newer claim and move the question to
   `open-questions.md`.
4. **Look for the missing.** Scan the mapped code areas (and recent commits
   touching them, `git log --oneline -- <area>`) for things that exist but the
   doc does not mention. Add what a future reader would need. Unlinked
   mentions count as missing: where a term, decision, or subject has a
   covering doc, add the first-mention link.
5. **Reassess the cadence.** If the doc churned a lot, shorten
   `review-interval-days`; if it was all confirmed, consider lengthening.
   Adjust only with a reason, and say so in your reply.
6. **Bump the frontmatter.** Set `last-reviewed` to today (UTC). Do this even
   when nothing else changed: the review itself is the event being recorded.
7. **Commit and report.** Commit as `docs: review <doc>` describing what was
   confirmed, fixed, and flagged. If nothing changed, the commit is just the
   frontmatter bump. Deliver the fixed/flagged list in your reply.

## Writing conventions

Concise and factual, Canadian spelling, Oxford comma, no em-dashes, no
horizontal rule directly above a header, text-based formats only (Markdown,
Mermaid, CSV/TSV). Write for a reader with zero session context. Link on
first mention: the first time you name a domain term, a decision, or another
doc's subject, link its doc (repo-relative paths); once per doc is enough. Date
external facts: a claim about an external system, vendor, or rule carries an
as-of date ("as of 2026-06") and its source; re-verifying against the source
refreshes the date.
