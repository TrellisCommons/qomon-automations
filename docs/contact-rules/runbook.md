---
last-reviewed: 2026-10-09
review-interval-days: 30
---

# Contact rules: runbook

How to set up a space, run the backfill, and leave the hourly job running. One job runs every rule a space has on: the household match always, and the deceased rule when the space has a deceased field. Why it works this way is in [the design doc](design.md).

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
3. **Turn on the deceased rule**, if the space marks deceased contacts. The space needs a custom field (checkbox or single choice) with a deceased option, and nothing else should be ticked with it: a contact with both "deceased" and another option is left alone and counted as `deceasedAmbiguous`.

   ```bash
   job space:add --key <space-key> --name "<Campaign name>" --canvassed <same as above> \
     --deceased-field "Deceased" --deceased-value yes
   ```

   `--deceased-value` is the option's **stored** value (`yes` by default). `--deceased-field ''` turns the rule off.
4. **Check the config against Qomon:** `job space:check --key <space-key>` lists the Presence form's values, confirms every configured value is on it, and says whether the deceased rule is on.

## Backfill

The first run catches up on every address knocked so far and, with the deceased rule on, every contact already marked deceased. Do it by hand, before turning on the timer, and again whenever the deceased rule is turned on for a space that already has marked contacts: those writes count toward the write limit, so the first hourly run would trip.

1. **Dry run**, with a report of the planned writes (contact ids only). Write the report outside any git checkout; the job refuses a path inside one.

   ```bash
   job contact-rules --space <space-key> --backfill --report /root/backfill-dry-run.csv
   ```

   The output line has the counts. Household match: `fetched`, `outsideMunicipality`, `unkeyable`, `households`, `canvassedHouseholds`, `alreadyHavePresence`, `planned`, and `remarks`. Deceased: `deceased`, `deceasedPlanned` ("Do not contact" to turn on), `deceasedAmbiguous`, and `deceasedOtherValue` (contacts holding only another option, such as "NOT deceased", to clean up by hand).
2. **Check a sample** of planned contacts in Qomon. A `presence` row should share an address with its `trigger_contact_id` and have no Presence; compare against the Google Sheet's List 1 (counts will differ: the job covers every contact, not only voters). A `black_list` row should be marked deceased and not yet "Do not contact". Compare `deceased` with a Qomon list filtered on the deceased field.
3. **Turn writes on** for the space, saying why:

   ```bash
   job space:writes --key <space-key> --on --reason "backfill checked: <who>, <sample size>"
   ```
4. **Apply**, with `--max-writes` a little above the dry run's `planned` (new knocks land between the two runs):

   ```bash
   job contact-rules --space <space-key> --backfill --apply --max-writes <rows in the dry-run report + 10%>
   ```

   It writes in batches of 20 contacts, one upsert per contact carrying all of its changes, and verifies each by reading it back. Each contact is a read, the upsert, and at least one read back, so at `QOMON_RPS=5` expect 1 to 2 writes per second, about 10 to 15 minutes per 1,000. `QOMON_RPS=8` (Qomon refills at 10 per second) brings that to about 7 minutes. If more than `MAX_FAILED_SHARE` of writes fail, it stops and turns the space's writes off. Over `--max-writes` it writes nothing and exits 2; dry-run again.
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
cp deploy/systemd/qomon-contact-rules@.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qomon-contact-rules@<space-key>.timer
systemctl list-timers 'qomon-*'
journalctl -u 'qomon-contact-rules@*' --since today
```

`/etc/qomon-automations/compose.env` holds `POSTGRES_PASSWORD` for Compose; `/etc/qomon-automations/.env` holds the job's environment, with `QOMON_WRITES_ALLOWED=true`. Both are root-only.

Each run posts to Slack only when something went wrong (a write failed, the run failed, or a breaker tripped) or a person must decide something. Successful runs post nothing; check them with `job status`. It pings `HEALTHCHECK_URL` at the end (`/fail` on failure), so a dead timer shows up as a missed ping.

| Exit | Meaning |
|---|---|
| 0 | done, nothing to do, the space is past `activeUntil`, or another run held the lock |
| 1 | the run failed (Slack has the error) |
| 2 | a circuit breaker tripped; for an hourly run the space's writes are now off |
| 3 | interrupted by a signal; safe to run again |
| 64 | bad command line |

## When a breaker trips

1. Read the run: `job report --run <run id> --out /root/run.csv` and `journalctl`. `FAILED` rows say why (`not visible after 120s`, `a different Presence was recorded`).
2. Fix the cause (a Qomon outage, a changed form, a bad plan).
3. Dry-run, then `job space:writes --key <space-key> --on --reason "<what was wrong>"`.

## When Slack lists contacts no longer marked deceased

The deceased rule turned "Do not contact" on for these contacts, and someone has since removed the deceased mark without turning "Do not contact" off. The job never turns it off. For each contact, decide in Qomon: turn "Do not contact" off if the person is alive and may be contacted, or leave it. Each contact is listed once.

## After the election

Runs after `activeUntil` exit without fetching anything. Disable the timer the next day: `systemctl disable --now qomon-contact-rules@<space-key>.timer`.
