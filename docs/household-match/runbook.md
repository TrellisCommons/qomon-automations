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

1. **Add the household value to the Presence form in Qomon** (space settings, Presence). The job refuses to run until the form has it. Until then you can configure `absent` as the household value, but automated values would then be indistinguishable from real visits.
2. **Add the space.** The API key comes from stdin, so it is not in shell history:

   ```bash
   read -rs QOMON_KEY && printf '%s' "$QOMON_KEY" | job space:add \
     --key <space-key> --name "<Campaign name>" \
     --canvassed present,absent,refus,repasse \
     --household-value "Absent (household)" \
     --municipality "<City>" --active-until 2026-10-31T23:59:59-04:00
   unset QOMON_KEY
   ```

   The canvassed values are the form's **stored** values, which can differ from its labels. A new space starts with writes off. Run `space:add` again (without stdin) to change settings; the key is kept.
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

   It writes in batches of 20 and verifies each by reading it back. Each write is a read, the upsert, and at least one read back, so at the client's 5 requests per second expect 1 to 2 writes per second: about 10 to 15 minutes per 1,000. If more than `MAX_FAILED_SHARE` of writes fail, it stops and turns the space's writes off. Over `--max-writes` it writes nothing and exits 2; dry-run again.
5. Re-running is safe: each run plans only what is still missing.

## Hourly

```bash
cp deploy/systemd/qomon-household-match@.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qomon-household-match@<space-key>.timer
systemctl list-timers 'qomon-*'
journalctl -u 'qomon-household-match@*' --since today
```

`/etc/qomon-automations/compose.env` holds `POSTGRES_PASSWORD` for Compose; `/etc/qomon-automations/.env` holds the job's environment, with `QOMON_WRITES_ALLOWED=true`. Both are root-only.

Each run posts to Slack only when it applied writes, a write failed, or the run failed or tripped. It pings `HEALTHCHECK_URL` at the end (`/fail` on failure), so a dead timer shows up as a missed ping.

| Exit | Meaning |
|---|---|
| 0 | done, nothing to do, the space is past `activeUntil`, or another run held the lock |
| 1 | the run failed (Slack has the error) |
| 2 | a circuit breaker tripped; for an hourly run the space's writes are now off |
| 64 | bad command line |

## When a breaker trips

1. Read the run: `job report --run <run id> --out /root/run.csv` and `journalctl`. `FAILED` rows say why (`not visible after 120s`, `a different Presence was recorded`).
2. Fix the cause (a Qomon outage, a changed form, a bad plan).
3. Dry-run, then `job space:writes --key <space-key> --on --reason "<what was wrong>"`.

## After the election

Runs after `activeUntil` exit without fetching anything. Disable the timer the next day: `systemctl disable --now qomon-household-match@<space-key>.timer`.
