---
last-reviewed: 2026-10-11
review-interval-days: 30
---

# Household match: runbook

How to set up a space, run the backfill, and leave the hourly job running. Why it works this way is in [the design doc](design.md).

All commands run the job image on the droplet:

```bash
cd /opt/qomon-automations
alias job='docker compose --profile job run --rm job'
```

Locally, `pnpm build` then `pnpm job <command>` with a `.env` (see `.env.example`). Locally `QOMON_WRITES_ALLOWED` stays `false`, so nothing is ever written.

## Before the first run

1. **Create the marker field in Qomon**: a custom field labelled `Presence source`, **single choice**, with two options: "Household match" (`household_match`) and "Recanvassed" (`recanvassed`). The job uses the stored values; the labels are free. The job refuses to run without it. (Qomon's Presence values cannot be extended, so the job writes `absent` and marks it with this field.)
2. **Add the space.** The API key comes from stdin, so it is not in shell history:

   ```bash
   read -rs QOMON_KEY && printf '%s' "$QOMON_KEY" | job space:add \
     --key <space-key> --name "<Campaign name>" \
     --canvassed present,absent,refus,repasse \
     --municipality "<City>" --active-until 2026-10-31T23:59:59-04:00
   unset QOMON_KEY
   ```

   The canvassed values are the form's **stored** values, which can differ from its labels. The household value (`absent`) and the marker (`Presence source` = `household_match`, re-marked `recanvassed`) are the defaults; `--household-value`, `--marker-field`, `--marker-value`, and `--recanvassed-value` change them. A new space starts with writes off. Run `space:add` again (without stdin) to change settings; the key is kept.
3. **Check the config against Qomon:** `job space:check --key <space-key>` lists the form's values and confirms every configured value is on it.

## Backfill

The first run catches up on every address knocked so far. Do it by hand, before turning on the timer.

1. **Dry run**, with a report of the planned writes (contact ids only). Write the report outside any git checkout; the job refuses a path inside one.

   ```bash
   job household-match --space <space-key> --backfill --report /root/backfill-dry-run.csv
   ```

   The output line has the counts: `fetched`, `outsideMunicipality`, `unkeyable`, `households`, `canvassedHouseholds`, `alreadyHavePresence`, and `planned`.
2. **Check a sample** of planned contacts in Qomon: each should share an address with its `trigger_contact_id` and have no Presence. Compare against the Google Sheet's List 1 (counts will differ: the job covers every contact, not only voters).
3. **Turn writes on** for the space, saying why:

   ```bash
   job space:writes --key <space-key> --on --reason "backfill checked: <who>, <sample size>"
   ```
4. **Apply**, with `--max-writes` a little above the dry run's `planned` (new knocks land between the two runs):

   ```bash
   job household-match --space <space-key> --backfill --apply --max-writes <planned + 10%>
   ```

   It writes in batches of 20 and verifies each by reading it back. Each write is a read, the upsert, and at least one read back, so at `QOMON_RPS=5` expect 1 to 2 writes per second, about 10 to 15 minutes per 1,000. `QOMON_RPS=8` (Qomon refills at 10 per second) brings that to about 7 minutes. If more than `MAX_FAILED_SHARE` of writes fail, it stops and turns the space's writes off. Over `--max-writes` it writes nothing and exits 2; dry-run again.
5. **Watch it** from another shell; progress is saved after every batch:

   ```bash
   job status --space <space-key>
   ```

## Stopping and restarting

Any run can be stopped and run again; the next run fetches afresh and plans only what is still missing.

- **Ctrl-C or `systemctl stop`** (SIGINT or SIGTERM): the run finishes the write in hand, verifies what it already sent, and exits 3 (`INTERRUPTED`). A second Ctrl-C exits at once.
- **Killed outright** (lost connection, `kill -9`, reboot): the run stays `RUNNING`. The next run settles it first: it reads back that run's unverified writes, records what Qomon has, and marks it `INTERRUPTED`.
- **To restart a backfill**, run the same apply command again. Its plan is smaller by what already landed, so the same `--max-writes` still fits.

## Hourly

```bash
cp deploy/systemd/qomon-household-match@.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qomon-household-match@<space-key>.timer
systemctl list-timers 'qomon-*'
journalctl -u 'qomon-household-match@*' --since today
```

`/etc/qomon-automations/compose.env` holds `POSTGRES_PASSWORD` for Compose; `/etc/qomon-automations/.env` holds the job's environment, with `QOMON_WRITES_ALLOWED=true`. Both are root-only.

Each run posts to Slack only when something went wrong: a write failed, the run failed, or a breaker tripped. Successful runs post nothing; check them with `job status`. It pings `HEALTHCHECK_URL` at the end (`/fail` on failure), so a dead timer shows up as a missed ping.

| Exit | Meaning |
|---|---|
| 0 | done, nothing to do, the space is past `activeUntil`, or another run held the lock |
| 1 | the run failed (Slack has the error) |
| 2 | a circuit breaker tripped; for an hourly run the space's writes are now off |
| 3 | interrupted by a signal; safe to run again |
| 64 | bad command line |

## Every minute

An incremental run (`--incremental`) fetches only contacts changed since the space's cursor and their streets, so it can run every minute; [the design doc](design.md) has how. The hourly full run stays: it catches what incremental runs miss and retries what they left undone.

1. **Shadow it** for a day: incremental dry runs every minute while the hourly full run keeps writing. The override drops `--apply`:

   ```bash
   cp deploy/systemd/qomon-household-match-incremental@.{service,timer} /etc/systemd/system/
   systemctl edit qomon-household-match-incremental@<space-key>.service
   ```

   ```ini
   [Service]
   ExecStart=
   ExecStart=/usr/bin/docker compose --profile job run --rm job household-match --space %i --incremental
   ```

   ```bash
   systemctl enable --now qomon-household-match-incremental@<space-key>.timer
   ```
2. **Compare.** Of the household values full runs wrote, how many incremental runs planned too:

   ```bash
   job shadow --space <space-key> --since <when the shadow started, ISO>
   ```

   A write counts as missed only when an incremental run started after its trigger's knock and before the full run; writes the full run got to first are counted separately. Look up a missed contact id: a housemate whose street starts with a different word is the expected cause, and a knock synced long after it was recorded can also read as a miss, as can a write whose reason has no knock time (the report errs toward misses). With no incremental runs in the window the report says so instead of reporting none missed: check the incremental timer.
3. **Switch.** Remove the override, so incremental runs apply:

   ```bash
   systemctl revert qomon-household-match-incremental@<space-key>.service
   systemctl restart qomon-household-match-incremental@<space-key>.timer
   ```

`job status` shows each run's `fetched` line: `full`, or how many contacts changed and how many streets were searched, and why a run fell back to a full fetch. A failed run is not posted again while runs of the same kind keep failing with the same error, so an outage posts once. Incremental runs ping `HEALTHCHECK_URL_INCREMENTAL` (period a minute) and full runs `HEALTHCHECK_URL` (period an hour), each in `/etc/qomon-automations/.env`. A full run waits up to 10 minutes for an incremental run's lock; if it never gets it, it posts to Slack and exits 1. Incremental runs that succeeded without planning a write are deleted after 7 days; runs with writes and failed runs are kept.

## When a breaker trips

1. Read the run: `job report --run <run id> --out /root/run.csv` and `journalctl`. `FAILED` rows say why (`not visible after 120s`, `a different Presence was recorded`).
2. Fix the cause (a Qomon outage, a changed form, a bad plan).
3. Dry-run, then `job space:writes --key <space-key> --on --reason "<what was wrong>"`.

## After the election

Runs after `activeUntil` exit without fetching anything. Disable the timers the next day: `systemctl disable --now qomon-household-match@<space-key>.timer qomon-household-match-incremental@<space-key>.timer`.
