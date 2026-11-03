---
last-reviewed: 2026-11-02
review-interval-days: 180
---

# Space archive runbook

Archive a Qomon space before it closes, and prove the archive restores with no network. The tools are in `tools/space-archive/`: `archive_space.py` reads the space into a folder of JSON, and `restore_archive.py` with `restore_checks.py` rebuilds it as SQLite and checks it against the source files.

The archive holds every contact in the space. Keep it outside any git work tree, on an encrypted disk; both scripts refuse otherwise. Never paste archive contents, or counts from a real archive, into an issue or PR.

## Archive

Read-only: GETs and read-only `POST /search` and `POST /kpi`. Qomon allows about 10 requests per second per space ([Qomon API notes](../integrations/qomon-api.md#rate-limits)), shared with the campaign's own users, so run it when the space is quiet.

```bash
cd tools/space-archive
printf %s "$QOMON_API_KEY" | uv run --with requests python archive_space.py ~/qomon-archive
```

Stages run in this order; `--stages` picks a subset.

| Stage | What it reads | Requests |
|---|---|---|
| `contacts` | Every contact, with interactions and form answers, through `POST /search`; fails if the count differs from `POST /kpi` | 1 per 1,000 contacts |
| `lists` | Space-level lists (actions, forms, surveys, email campaigns, donations, transactions, users, teams, and others) | about 80 |
| `details` | One request per action, form, survey, import, email campaign and template, workflow, bundle, user, and team | 1 per record |
| `per-contact` | `/contacts/{id}/history` and `/contacts/{id}/notes`; `--contact-scope activity` (default) covers contacts with interactions, form answers, or a recorded change, `sample` adds 200 others, `all` covers everyone | 2 per contact |
| `contact-details` | `/contacts/{id}`, which carries tags and custom fields that search leaves out | 1 per contact |
| `segments` | Contact ids per email campaign (sent, opened, clicked), action, and online form | 1 per segment, plus pages |
| `metabase` | Every card of each signed Metabase embed dashboard in `QOMON_METABASE_TOKENS` (comma-separated tokens copied from the Qomon dashboard pages) | 1 per card |
| `assets` | Images that Qomon's vendors host for templates and forms | 1 per image |

Run `--contact-scope sample` before `all`: if the sample's history holds only import events and no notes, the rest of the contacts add nothing. `--workers` and `--requests-per-second` speed up per-id stages; concurrency halves on a 429, a 5xx, or a response slower than 15 seconds.

A rerun skips finished endpoints and resumes per-id stages from the ids already written. `--retry-failed` retries endpoints in `manifest.json`'s `failed`; `--only NAME` runs single lists or details. `archive.log` records each endpoint's start and end with counts only.

Failures seen as of 2026-10:
- `emailer_campaign_report` returned 500 on 20 campaigns in a row; `emailer_campaign_kpi_v2` holds campaign results.
- `import_columns` returned 400 on 20 imports in a row. Import settings are in `import_properties`.

When every stage is done:

```bash
uv run python archive_space.py ~/qomon-archive --verify
uv run python archive_space.py ~/qomon-archive --seal
```

`--verify` rechecks every file in the manifest against its SHA-256 and line count. `--seal` writes `HASHES.sha256` over every file. Neither calls the API or writes to `archive.log`. Seal last: a file added or changed afterwards fails the restore until you seal again.

Copy `tools/space-archive/` into the archive as `tools/` before sealing, so the archive restores without this repo.

## Restore and check

Standard library only, Python 3.10 or later, no network. Run it on a copy of the archive or straight from the backup; it only reads the archive.

```bash
python3 -B tools/restore_archive.py <archive> <output.sqlite>
python3 -B tools/restore_checks.py <archive> <output.sqlite>
```

`restore_archive.py` stops if a file fails `HASHES.sha256`, if the archive has a file the hash list does not name, or if the output is inside a git work tree or on an unencrypted disk (the encryption check is macOS only). It prints table counts only.

`restore_checks.py` exits 1 on any failure. It checks that:
- Each `raw` column matches its source record, for contacts, notes, history, actions, donations, transactions, bundles, users, and forms.
- Every segment's contact list matches.
- No contact id appears twice.
- Every archive file is listed in `load_coverage`.

It also runs each query in `restore_queries.sql`. A query whose header has an expected value (`-- contacts | 1234`) is a check; one without prints its count as INFO. The repo's copy has no expected values. Add them to the copy inside each archive, from a restore you have checked by hand.

To prove the restore needs no network on macOS, run both scripts under `sandbox-exec` with a profile that denies `network*`.

Each table keeps the source record in `raw`. `history_*` tables hold one row per history event, split by type; `dangling_*` columns flag answers, participations, and segment entries whose form, action, or contact is not in the archive.

## Re-import field map

Not yet tested. Write only to a test space, with invented data, and never to the archived space. Upsert on `id`; never `PATCH` a contact (see [Qomon API notes](../integrations/qomon-api.md#upsert)).

| Data | Approach | Source table |
|---|---|---|
| Contacts: name, address, phones, email | Recreate with upsert | `contacts` (`contacts_search` where the detail record is empty) |
| Tags | Recreate | `contact_tags` |
| Custom field values | Recreate, after defining the fields by hand | `contact_custom_fields` |
| Survey answers | Custom field per question, or a note; the API cannot write forms or surveys | `survey_answers` |
| Notes | Recreate; author and original date go in the note text | `notes` |
| Logged interactions | Recreate | `history_interaction` |
| Teams | Recreate; membership needs the new user ids | `teams_with_users` |
| Donations and transactions | Recreate as new bundles; original ids are lost | `transaction_bundles`, `transactions`, `donations` |
| Actions and participation | Tag per action; the API cannot write actions | `actions`, `action_details`, `history_participation` |
| Email and SMS history | Summary note or tag per campaign | `history_email`, `history_sms`, `segments` |
| Email and SMS campaigns, forms, online forms, workflows, surveys | Rebuild by hand, or leave in the archive | `email_campaigns`, `forms`, `online_forms`, `archive_files` |
| Import history, original ids and dates, dashboards | Cannot recreate | `history_import`, `archive_files` |

Report money from `transactions`, not `donations`: the two can disagree, for example when a $0 donation is recorded or a bundle is edited after the fact. Copying donations as they are repeats the gap.

Before any write, create one id map row per source contact, and have every later write look up `new_id`:

```sql
CREATE TABLE contact_id_map (
    old_id INTEGER PRIMARY KEY REFERENCES contacts (id),
    new_id INTEGER UNIQUE,
    target_group_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'created', 'failed', 'skipped')),
    error TEXT
);
```
