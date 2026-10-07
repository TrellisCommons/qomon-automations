# qomon-automations

Scheduled jobs that read and write a campaign's Qomon space. The first job is the household match: when a canvasser records a Presence on one contact, every other contact at that address gets "Absent (household)". The plan is [issue #1](https://github.com/TrellisCommons/qomon-automations/issues/1).

## This repo is public

Anything committed, pushed, or posted here is visible to everyone and stays in git history. Never put personal information or confidential information in:
- code
- tests and fixtures
- comments
- docs
- commit messages
- branch names
- issues
- pull requests
- screenshots

| Never include | Examples |
|---|---|
| Personal information about real people | Names, street addresses, emails, phone numbers, birthdates, Presence or canvass results, donation history, tags on a real contact |
| Identifiers that point at real records | Qomon contact IDs, user IDs, form IDs, and space IDs from a real space |
| Campaign data | Exports, CSVs, voter lists, counts or statistics from real runs, Google Sheet links |
| Secrets | API keys, tokens, passwords, connection strings, SSH keys, droplet IPs |
| Material shared in confidence | Qomon's OpenAPI specs and other vendor documents not published by the vendor |

Rules that follow from this:
- **Secrets go in `.env` only.** It is gitignored. `.env.example` lists variable names with empty or dummy values.
- **Fixtures are synthetic.** Use invented names and invented addresses (for example "123 Example St"). Never copy a real row and alter it.
- **Logs carry IDs and counts, never names or addresses.** Logs stay on the droplet and are never pasted into an issue or PR.
- **Real data never enters the repo folder.** Exports and debug dumps go outside the repo, never in a gitignored subfolder that could be committed by mistake.
- **Describe a bug with an invented example,** not the contact it happened to.
- **Check the diff before every commit and push** for anything in the table above. CI runs a secret scan, but nothing scans for personal information.

If personal or confidential information is committed, stop and tell Ian. Deleting it in a new commit does not remove it from history.

## Writing to Qomon

A write to Qomon changes a live campaign's data. All writes are off unless `QOMON_WRITES_ALLOWED=true` and the space has writes enabled. Never set either while testing; use the sandbox space.

## Docs

Canadian spelling, Oxford comma, no em dashes, no horizontal rule directly above a header, text formats only.
