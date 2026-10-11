---
last-reviewed: 2026-10-09
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

## Incremental job

For spaces too large to fetch every hour, or to run every minute: see [the incremental design](incremental-design.md). **Check first** that a Presence recorded in the canvassing app moves the contact's `UpdatedAt`; if it does not, this job misses knocks until the nightly sweep.

1. **Seed** the mirror with a dry-run sweep (`job household-match --space <space-key> --sweep`). The first run would sweep anyway; doing it by hand shows how long it takes. Households that need nothing are settled; the rest wait for writes (re-planned hourly while writes are off).
2. **Shadow** for a day: enable the minutely timer with `--apply` removed from `ExecStart` (a dry run), alongside the hourly full job.
3. **Switch**: disable the hourly timer, restore `--apply`, and enable both:

   ```bash
   cp deploy/systemd/qomon-household-match-{incremental,sweep}@.{service,timer} /etc/systemd/system/
   systemctl daemon-reload
   systemctl disable --now qomon-household-match@<space-key>.timer
   systemctl enable --now qomon-household-match-incremental@<space-key>.timer qomon-household-match-sweep@<space-key>.timer
   ```

   The sweep and the minutely run share the job's lock: a tick during a sweep exits at once, and a sweep waits up to 15 minutes for a minutely run to finish.
4. **Quarantined households**: the alert names none; find them with `select "householdHash", attempts, "lastError" from dirty_household where "quarantinedAt" is not null`, look at the cause, then `job release --space <space-key> --household <hash>` (or `--contact <id>`).

5. **Sweep deletions refused**: a sweep's listing was missing more contacts than `SWEEP_MAX_DELETES`, so none were removed from the mirror. Check in Qomon whether they were really deleted; if so, run one sweep with a higher `SWEEP_MAX_DELETES`.
6. **Rotating `SPACE_SECRET_KEY`**: the next incremental run notices and sweeps the space to rehash every household. Expect it to take as long as the seed.

Each schedule pings its own check, so the minutely run's pings cannot hide a failed or missing sweep: `HEALTHCHECK_URL_INCREMENTAL` (period 1 minute, grace a few minutes) and `HEALTHCHECK_URL_SWEEP` (period 1 day). `HEALTHCHECK_URL` stays the full job's. An unset URL means no ping. The incremental and sweep ping body is `{ cursorAgeSeconds, workLagSeconds, quarantined }`, which Healthchecks shows with each ping.

Successful incremental runs that wrote nothing are deleted from `job_run` after 7 days; runs with writes and failed runs are kept.

## When a breaker trips

1. Read the run: `job report --run <run id> --out /root/run.csv` and `journalctl`. `FAILED` rows say why (`not visible after 120s`, `a different Presence was recorded`).
2. Fix the cause (a Qomon outage, a changed form, a bad plan).
3. Dry-run, then `job space:writes --key <space-key> --on --reason "<what was wrong>"`.

## After the election

Runs after `activeUntil` exit without fetching anything. Disable the timer the next day: `systemctl disable --now qomon-household-match@<space-key>.timer`.
