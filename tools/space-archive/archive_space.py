"""Archive everything readable from one Qomon space into a folder of JSON with a manifest.

Read-only: GETs and read-only POST searches. Each endpoint declares how it exports:
  none          one request returns the full list
  limit_offset  paged until the API's `total`
  per_id        one request per id from an earlier file

Folder layout:
  archive.log            timestamped start/finish of every endpoint; counts only
  manifest.json          every file, its endpoint, counts, SHA-256; failures; endpoints never called
  contacts.jsonl         every contact, with interactions and form answers inline
  reference/NAME.json    space-level lists
  details/NAME.jsonl     per-record endpoints
  contact_history.jsonl, contact_notes.jsonl, contact_details.jsonl   per-contact endpoints
  segments.jsonl         contact ids per email campaign (sent, opened, clicked), action, and online form
  metabase/NAME.json     every card of a signed Metabase embed dashboard
  assets/, assets_index.jsonl   images hosted by Qomon's vendors

Resumable: a rerun skips finished endpoints, and per-id endpoints continue from ids already written.
The API key is read from stdin, and the archive folder must be outside any git work tree:
    printf %s "$QOMON_API_KEY" | uv run --with requests python archive_space.py ~/qomon-archive --stages contacts

The metabase stage reads comma-separated embed tokens from QOMON_METABASE_TOKENS.
--seal writes HASHES.sha256 over every file; run it last, since any later change breaks the restore.
"""

import base64
import argparse
import hashlib
import json
import logging
import os
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests

INCOMING = "https://incoming.qomon.app"
INTERNAL = "https://qomon.app/api"
PAGE_SIZE = 100
SEARCH_PAGE_SIZE = 1000
MAX_CONSECUTIVE_FAILURES = 20
PROGRESS_EVERY = 500
MATCH_ALL = {"$all": [{"$all": [{"$condition": {"attr": "UpdatedAt", "ope": "gte", "value": "now-50y/d"}}]}]}

NEVER_CALLED = [
    "login, oauth, stripe, refresh, verify, access_token, grantspace, unsubscribe, doubleoptin: side effects",
]
# name, base, path, paging
LISTS = [
    ("consents", INTERNAL, "/consents", "none"),
    ("consent_settings", INTERNAL, "/consent_settings", "none"),
    ("privacy_policy", INTERNAL, "/privacy-policy", "none"),
    ("domains", INTERNAL, "/domains", "none"),
    ("retrieve_accounts", INTERNAL, "/retrieveaccounts", "none"),
    ("action_hub", INTERNAL, "/action_hub", "none"),
    ("brandkit", INTERNAL, "/brandkit", "none"),
    ("billing_subscription", INTERNAL, "/billing/subscription", "none"),
    ("sanction_authorities", INTERNAL, "/sanction_authorities", "none"),
    ("sanction_types", INTERNAL, "/sanction_types", "none"),
    ("current_batches", INTERNAL, "/current_batchs", "none"),
    ("me", INTERNAL, "/me", "none"),
    ("my_group", INTERNAL, "/mygroup", "none"),
    ("emailer_account_status", INTERNAL, "/emailer/account/status", "none"),
    ("emailer_kpi_aggregate", INTERNAL, "/v2/kpi/emailer/campaigns/aggregate", "none"),
    ("territory_overview", INTERNAL, "/territory-api/live/user/overview?geo_root_alias=CAN", "none"),
    ("forms_static", INTERNAL, "/forms/name/STATIC", "none"),
    ("forms_custom", INTERNAL, "/forms/name/CUSTOM", "none"),
    ("forms_action", INTERNAL, "/forms/name/ACTION", "none"),
    ("forms_status", INTERNAL, "/forms/name/STATUS", "none"),
    ("forms_form", INTERNAL, "/forms/name/FORM", "none"),
    ("forms_consent", INTERNAL, "/forms/name/CONSENT", "none"),
    ("forms_name_presence", INTERNAL, "/forms/name/name_presence", "none"),
    ("forms_brief", INTERNAL, "/forms/name/BRIEF", "none"),
    ("actions", INCOMING, "/actions", "none"),
    ("actions_by_group", INTERNAL, "/actionsfilterbygroup", "none"),
    ("actions_by_user", INTERNAL, "/actionsfilterbyuser", "none"),
    ("global_actions", INTERNAL, "/globalaction", "none"),
    ("autosends", INTERNAL, "/autosends", "none"),
    ("categories", INTERNAL, "/categories", "none"),
    ("emailer_senders", INTERNAL, "/emailer/allsenders", "none"),
    ("emailer_campaigns", INTERNAL, "/emailer/campaigns/list", "none"),
    ("emailer_domains", INTERNAL, "/emailer/domains", "none"),
    ("emailer_invalid_contacts", INTERNAL, "/emailer/invalid-contacts", "none"),
    ("emailer_templates", INTERNAL, "/emailer/templates", "none"),
    ("emailer_template_variables", INTERNAL, "/emailer/template/variables", "none"),
    ("filters", INTERNAL, "/filters", "none"),
    ("folders", INTERNAL, "/folders", "none"),
    ("forms", INTERNAL, "/forms", "none"),
    ("forms_survey", INCOMING, "/forms/survey", "none"),
    ("surveys", INTERNAL, "/surveys", "none"),
    ("surveys_usage", INTERNAL, "/surveys/usage", "none"),
    ("imports", INCOMING, "/imports", "none"),
    ("insights", INTERNAL, "/insights", "none"),
    ("bulk_jobs", INTERNAL, "/massive-manipulations/jobs", "none"),
    ("member_invitations", INTERNAL, "/member-invitations", "none"),
    ("group", INTERNAL, "/mygroup", "none"),
    ("groups", INTERNAL, "/mygroups", "none"),
    ("mandate_organisations", INTERNAL, "/mandates/organisations", "none"),
    ("mandate_titles", INTERNAL, "/mandates/titles", "none"),
    ("notifications", INTERNAL, "/notifications", "none"),
    ("online_forms", INTERNAL, "/online-forms", "none"),
    ("petitions", INTERNAL, "/petitions", "none"),
    ("roles", INCOMING, "/roles", "none"),
    ("role_templates", INTERNAL, "/roles/templates", "none"),
    ("tags", INTERNAL, "/tags", "none"),
    ("teams", INCOMING, "/teams", "none"),
    ("teams_with_users", INTERNAL, "/teams-by-group-id", "none"),
    ("user_invitations", INCOMING, "/users/invitation", "none"),
    ("interaction_tags", INCOMING, "/v1/interactions/tags", "none"),
    ("donation_prices", INCOMING, "/v1/donation_prices", "none"),
    ("donations_kpi", INCOMING, "/v1/donations/kpi", "none"),
    ("memberships", INCOMING, "/v1/memberships", "none"),
    ("code_campaigns", INCOMING, "/v1/code_campaigns", "none"),
    ("transaction_settings", INCOMING, "/v1/transaction_settings", "none"),
    ("turf_layers", INTERNAL, "/turf/layers", "none"),
    ("turfs", INTERNAL, "/turf/turfs", "none"),
    ("workflows", INTERNAL, "/workflows", "none"),
    ("bulk_updates", INTERNAL, "/metamorph", "none"),
    ("xlsx_exports", INTERNAL, "/xlsx-exports?limit=1000&offset=0", "none"),
    ("batches", INTERNAL, "/batchs?limit=1000&offset=0", "none"),
    ("payment_methods", INTERNAL, "/payment_methods", "none"),
    ("transaction_status_motifs", INTERNAL, "/transaction_status_motifs", "none"),
    ("transaction_export_settings", INTERNAL, "/exports/transactions/settings", "none"),
    ("telnyx_profiles", INTERNAL, "/telnyx/messagingprofiles", "none"),
    ("mandate_settings", INTERNAL, "/mandates/settings", "none"),
    ("donations", INCOMING, "/v1/donations", "limit_offset"),
    ("transactions", INCOMING, "/v1/transactions", "limit_offset"),
    ("transaction_bundles", INCOMING, "/v1/transaction_bundles", "limit_offset"),
    ("transaction_statuses", INCOMING, "/v1/transaction_statuses", "limit_offset"),
    ("users", INCOMING, "/users", "limit_offset"),
]
# name, source list, base, path with {id}
DETAILS = [
    ("emailer_campaign_kpi_v2", "emailer_campaigns", INTERNAL, "/v2/kpi/emailer/campaigns/{id}"),
    ("action", "actions", INTERNAL, "/actions/{id}"),
    ("action_files", "actions", INTERNAL, "/action/{id}/files"),
    ("action_analytics", "actions", INTERNAL, "/action/{id}/analytics"),
    ("online_form", "online_forms", INTERNAL, "/online-forms/{id}"),
    ("form", "forms", INTERNAL, "/forms/{id}"),
    ("survey", "surveys", INTERNAL, "/survey/{id}"),
    ("import_columns", "imports", INCOMING, "/imports/{id}/columns"),
    ("import_properties", "imports", INCOMING, "/imports/{id}/properties"),
    ("import_statuses", "imports", INCOMING, "/imports/{id}/statuses"),
    ("emailer_campaign", "emailer_campaigns", INTERNAL, "/emailer/campaign/{id}"),
    ("emailer_campaign_report", "emailer_campaigns", INTERNAL, "/emailer/campaign/{id}/report"),
    ("emailer_campaign_kpi", "emailer_campaigns", INTERNAL, "/v2/kpi/emailer/campaigns/{id}"),
    ("emailer_template", "emailer_templates", INTERNAL, "/emailer/template/{id}"),
    ("workflow", "workflows", INTERNAL, "/workflows/{id}"),
    ("workflow_runs", "workflows", INTERNAL, "/workflows/{id}/runs"),
    ("transaction_bundle_history", "transaction_bundles", INCOMING, "/v1/transaction_bundles/{id}/history"),
    ("user", "users", INCOMING, "/users/{id}"),
    ("team", "teams", INCOMING, "/teams/{id}"),
]
PER_CONTACT = [("contact_history", "/contacts/{id}/history"), ("contact_notes", "/contacts/{id}/notes")]

METABASE = "https://metabase.qomon.app/api/embed/dashboard/"
EVER = "now-50y/d"

log = logging.getLogger("archive")

SAMPLE_SIZE = 200
ASSET_URL = re.compile(r'https?://(?:file-qomon\.s3\.fr-par\.scw\.cloud|[a-z0-9]+\.sdkmedia\.net|app-rsrc\.getbee\.io)/[^"\\\s)\']+')
SLOW_SECONDS = 15
CUT_COOLDOWN_SECONDS = 10
CLEAN_STREAK = 100


class Api:
    def __init__(self, key, requests_per_second, workers=1):
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {key}"
        self.interval = 1 / requests_per_second
        self.last = 0.0
        self.requests = 0
        self.lock = threading.Lock()
        self.slots = threading.Condition()
        self.limit = self.max_limit = workers
        self.active = 0
        self.streak = 0
        self.last_cut = 0.0

    def adapt(self, response, elapsed):
        """Halve concurrency on 429, 5xx, or slow responses; add one back after a clean streak."""
        struggling = response is None or response.status_code == 429 or response.status_code >= 500
        with self.slots:
            self.active -= 1
            now = time.monotonic()
            if struggling or elapsed > SLOW_SECONDS:
                self.streak = 0
                if self.limit > 1 and now - self.last_cut > CUT_COOLDOWN_SECONDS:
                    self.limit = max(1, self.limit // 2)
                    self.last_cut = now
                    log.warning("concurrency down to %d", self.limit)
            else:
                self.streak += 1
                if self.streak >= CLEAN_STREAK and self.limit < self.max_limit:
                    self.limit += 1
                    self.streak = 0
                    log.info("concurrency up to %d", self.limit)
            self.slots.notify_all()

    def call(self, method, url, **kwargs):
        retried = False
        rate_limited = 0
        while True:
            with self.slots:
                self.slots.wait_for(lambda: self.active < self.limit)
                self.active += 1
            with self.lock:
                wait = self.last + self.interval - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                self.last = time.monotonic()
                self.requests += 1
            sent = time.monotonic()
            try:
                response = self.session.request(method, url, timeout=60, **kwargs)
            except requests.RequestException:
                response = None
            self.adapt(response, time.monotonic() - sent)
            if response is not None and response.status_code == 429 and rate_limited < 6:
                rate_limited += 1
                log.warning("429 on %s, backing off", url)
                time.sleep(2**rate_limited)
                continue
            if (response is None or response.status_code >= 500) and not retried:
                retried = True
                time.sleep(1)
                continue
            return response


def records_in(body):
    """The largest list of dicts in a response, wherever the endpoint nests it."""
    best = []
    stack = [body]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            if node and isinstance(node[0], dict) and len(node) > len(best):
                best = node
        elif isinstance(node, dict):
            stack.extend(node.values())
    return best


def record_id(record):
    nested = record.get("Action")
    if isinstance(nested, dict):
        return nested.get("id", nested.get("ID"))
    return record.get("base_id") or record.get("id", record.get("ID"))


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Archive:
    def __init__(self, root, api, retry_failed, workers=1):
        self.workers = workers
        self.root = root
        self.api = api
        self.manifest_path = root / "manifest.json"
        if self.manifest_path.exists():
            self.manifest = json.loads(self.manifest_path.read_text())
        else:
            self.manifest = {"files": {}, "failed": {}}
        self.manifest["never_called"] = NEVER_CALLED
        self.retry_failed = retry_failed

    def done(self, name):
        return name in self.manifest["files"] or (name in self.manifest["failed"] and not self.retry_failed)

    def finish(self, name, path, endpoint, records, api_total=None):
        self.manifest["failed"].pop(name, None)
        self.manifest["files"][name] = {
            "file": str(path.relative_to(self.root)),
            "endpoint": endpoint,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "records": records,
            "api_total": api_total,
            "sha256": sha256(path),
        }
        self.save()

    def fail(self, name, endpoint, reason):
        self.manifest["failed"][name] = {"endpoint": endpoint, "reason": reason}
        self.save()
        log.error("FAILED %s: %s", name, reason)

    def save(self):
        temp = self.manifest_path.with_suffix(".tmp")
        temp.write_text(json.dumps(self.manifest, indent=2, ensure_ascii=False))
        temp.rename(self.manifest_path)

    def contacts(self):
        name = "contacts"
        if self.done(name):
            log.info("skip %s", name)
            return
        started, before = time.monotonic(), self.api.requests
        log.info("start %s", name)
        target, temp = self.root / "contacts.jsonl", self.root / "contacts.jsonl.tmp"
        seen = set()
        with temp.open("w", encoding="utf-8") as f:
            page = 0
            while True:
                search = {
                    "page": page,
                    "per_page": SEARCH_PAGE_SIZE,
                    "include_interactions": True,
                    "sort_attr": "surname",
                    "sort_asc": True,
                    "query": MATCH_ALL,
                }
                response = self.api.call("POST", INCOMING + "/search", json={"data": {"advanced_search": search}})
                if response is None or response.status_code >= 300:
                    self.fail(name, "POST /search", f"page {page}: {getattr(response, 'status_code', 'no response')}")
                    return
                contacts = (response.json().get("data") or {}).get("contacts") or []
                if not contacts:
                    break
                for contact in contacts:
                    if contact["id"] not in seen:
                        seen.add(contact["id"])
                        f.write(json.dumps(contact, ensure_ascii=False, sort_keys=True) + "\n")
                page += 1
                log.info("%s: page %d, %d unique contacts", name, page, len(seen))
        kpi = self.api.call("POST", INCOMING + "/kpi", json={"data": {"advanced_search": {"query": MATCH_ALL}}})
        total = kpi.json()["data"]["total"] if kpi is not None and kpi.status_code < 300 else None
        temp.rename(target)
        if total != len(seen):
            self.fail(name, "POST /search", f"{len(seen)} contacts but /kpi reports {total}")
            return
        self.finish(name, target, "POST /search include_interactions", len(seen), total)
        log.info("end %s: %d records, /kpi %s, %d requests, %.0fs", name, len(seen), total,
                 self.api.requests - before, time.monotonic() - started)

    def fetch_list(self, name, url, paging):
        if paging == "none":
            response = self.api.call("GET", url)
            if response is None or response.status_code >= 300:
                return None, getattr(response, "status_code", "no response")
            return {"response": response.json()}, None
        records, offset, total = [], 0, None
        while True:
            response = self.api.call("GET", url, params={"limit": PAGE_SIZE, "offset": offset})
            if response is None or response.status_code >= 300:
                return None, f"offset {offset}: {getattr(response, 'status_code', 'no response')}"
            body = response.json()
            data = body.get("data")
            total = body.get("total") or (data.get("total") or data.get("count") if isinstance(data, dict) else None)
            page = records_in(body)
            records += page
            offset += PAGE_SIZE
            if not page or total is None or len(records) >= total:
                return {"records": records, "total": total}, None

    def lists(self, only):
        folder = self.root / "reference"
        folder.mkdir(exist_ok=True)
        for name, base, path, paging in LISTS:
            if (only and name not in only) or self.done(name):
                continue
            started, before = time.monotonic(), self.api.requests
            log.info("start %s (%s)", name, paging)
            body, error = self.fetch_list(name, base + path, paging)
            if error is not None:
                self.fail(name, base + path, str(error))
                continue
            target = folder / f"{name}.json"
            temp = target.with_suffix(".tmp")
            temp.write_text(json.dumps(body, ensure_ascii=False))
            temp.rename(target)
            count = len(body["records"]) if "records" in body else len(records_in(body))
            total = body.get("total")
            self.finish(name, target, base + path, count, total)
            log.info("end %s: %d records, %d requests, %.1fs", name, count, self.api.requests - before,
                     time.monotonic() - started)
            if total is not None and count != total:
                self.fail(name, base + path, f"{count} records but total {total}")

    def per_id(self, name, ids, url_template, target):
        if self.done(name):
            log.info("skip %s", name)
            return
        self.manifest["failed"].pop(name, None)
        started, before = time.monotonic(), self.api.requests
        written = set()
        if target.exists():
            with target.open(encoding="utf-8") as f:
                written = {json.loads(line)["id"] for line in f}
        log.info("start %s: %d ids, %d already written", name, len(ids), len(written))
        failures, consecutive = 0, 0
        pending = [record for record in ids if record not in written]

        def fetch(record):
            return record, self.api.call("GET", url_template.format(id=record))

        pool = ThreadPoolExecutor(self.workers)
        try:
            with target.open("a", encoding="utf-8") as f:
                for record, response in pool.map(fetch, pending):
                    if response is None or response.status_code >= 300:
                        failures += 1
                        consecutive += 1
                        if consecutive >= MAX_CONSECUTIVE_FAILURES:
                            self.fail(name, url_template, f"gave up after {consecutive} consecutive failures")
                            return
                        continue
                    consecutive = 0
                    f.write(json.dumps({"id": record, "response": response.json()}, ensure_ascii=False) + "\n")
                    f.flush()
                    written.add(record)
                    if len(written) % PROGRESS_EVERY == 0:
                        log.info("%s: %d/%d, %d failures, %.0fs", name, len(written), len(ids), failures,
                                 time.monotonic() - started)
        finally:
            pool.shutdown(cancel_futures=True)
        self.finish(name, target, url_template, len(written), len(ids))
        if failures:
            self.fail(name, url_template, f"{failures} of {len(ids)} ids failed")
        log.info("end %s: %d records, %d failures, %d requests, %.0fs", name, len(written), failures,
                 self.api.requests - before, time.monotonic() - started)

    def details(self, only):
        folder = self.root / "details"
        folder.mkdir(exist_ok=True)
        for name, source, base, path in DETAILS:
            if only and name not in only:
                continue
            source_file = self.root / "reference" / f"{source}.json"
            if not source_file.exists():
                self.fail(name, base + path, f"{source} missing")
                continue
            body = json.loads(source_file.read_text())
            records = body["records"] if "records" in body else records_in(body)
            ids = [i for i in map(record_id, records) if i is not None]
            self.per_id(name, ids, base + path, folder / f"{name}.jsonl")

    def per_contact(self, limit, scope="activity"):
        with (self.root / "contacts.jsonl").open(encoding="utf-8") as f:
            contacts = list(map(json.loads, f))
        ids = [
            c["id"] for c in contacts if c.get("interactions") or c.get("formdatas") or c.get("lastchangeuserid")
        ]
        log.info("contacts with activity: %d", len(ids))
        self.manifest["contacts_with_activity"] = len(ids)
        self.save()
        rest = sorted({c["id"] for c in contacts} - set(ids))
        if scope == "sample":
            ids = ids + random.Random(2026).sample(rest, SAMPLE_SIZE)
        elif scope == "all":
            ids = ids + rest
            self.manifest["per_contact_scope"] = "all"
        partial = limit or scope == "sample"
        if limit:
            ids = ids[:limit]
        for name, path in PER_CONTACT:
            if partial or scope == "all":
                self.manifest["files"].pop(name, None)
            self.per_id(name, ids, INTERNAL + path, self.root / f"{name}.jsonl")
            if partial:
                self.manifest["files"].pop(name, None)
                self.save()

    def contact_details(self):
        with (self.root / "contacts.jsonl").open(encoding="utf-8") as f:
            ids = [json.loads(line)["id"] for line in f]
        self.per_id("contact_details", ids, INTERNAL + "/contacts/{id}", self.root / "contact_details.jsonl")

    def segment_ids(self, conditions):
        """Contact ids matching conditions, and /kpi's count for the same query."""
        query = {"$all": [{"$all": [{"$condition": c} for c in conditions]}]}
        kpi = self.api.call("POST", INCOMING + "/kpi", json={"data": {"advanced_search": {"query": query}}})
        if kpi is None or kpi.status_code >= 300:
            return None, None
        total = kpi.json()["data"]["total"]
        ids, page = [], 0
        while len(ids) < total:
            search = {"page": page, "per_page": SEARCH_PAGE_SIZE, "sort_attr": "surname", "sort_asc": True,
                      "query": query}
            response = self.api.call("POST", INCOMING + "/search", json={"data": {"advanced_search": search}})
            if response is None or response.status_code >= 300:
                return None, total
            contacts = (response.json().get("data") or {}).get("contacts") or []
            if not contacts:
                break
            ids += [c["id"] for c in contacts]
            page += 1
        return sorted(set(ids)), total

    def segments(self):
        name = "segments"
        if self.done(name):
            log.info("skip %s", name)
            return
        self.manifest["failed"].pop(name, None)

        def source(file):
            body = json.loads((self.root / "reference" / f"{file}.json").read_text())
            return records_in(body)

        jobs = []
        for campaign in source("emailer_campaigns"):
            match = {"attr": "emails.campaign_id", "ope": "eql", "value": str(campaign["id"])}
            jobs.append(("email_sent", campaign["id"], [match]))
            for kind, attr in (("email_opened", "emails.opened_at"), ("email_clicked", "emails.clicked_at")):
                jobs.append((kind, campaign["id"], [match, {"attr": attr, "ope": "gte", "value": EVER}]))
        for action in source("actions"):
            action_id = record_id(action)
            jobs.append(("action", action_id, [{"attr": "action_ids", "ope": "eql", "value": str(action_id)}]))
        for form in source("online_forms"):
            base = form.get("base_id") or form["id"]
            jobs.append(("online_form", base, [{"attr": "onlineforms.base_id", "ope": "eql", "value": str(base)}]))

        target = self.root / "segments.jsonl"
        written = set()
        if target.exists():
            with target.open(encoding="utf-8") as f:
                written = {(r["kind"], r["source_id"]) for r in map(json.loads, f)}
        log.info("start %s: %d queries, %d already written", name, len(jobs), len(written))
        failures, mismatches = 0, 0
        with target.open("a", encoding="utf-8") as f:
            for number, (kind, source_id, conditions) in enumerate(jobs, 1):
                if (kind, source_id) in written:
                    continue
                ids, total = self.segment_ids(conditions)
                if ids is None:
                    failures += 1
                    log.warning("%s: %s %s failed", name, kind, source_id)
                    continue
                mismatches += len(ids) != total
                f.write(json.dumps({"kind": kind, "source_id": source_id, "kpi_total": total, "contact_ids": ids}) + "\n")
                f.flush()
                written.add((kind, source_id))
                if number % 50 == 0:
                    log.info("%s: %d/%d, %d failures, %d count mismatches", name, number, len(jobs), failures, mismatches)
        self.finish(name, target, "POST /search by campaign, action, online form", len(written), len(jobs))
        if failures:
            self.fail(name, "POST /search", f"{failures} of {len(jobs)} queries failed")
        log.info("end %s: %d records, %d failures, %d count mismatches", name, len(written), failures, mismatches)

    def metabase(self):
        tokens = [t for t in os.environ.get("QOMON_METABASE_TOKENS", "").split(",") if t]
        folder = self.root / "metabase"
        folder.mkdir(exist_ok=True)
        log.info("start metabase: %d dashboards", len(tokens))
        for token in tokens:
            # Plain requests: the API key must not reach Metabase.
            dashboard = requests.get(METABASE + token, timeout=60)
            if dashboard.status_code >= 300:
                self.fail("metabase", "embed dashboard", str(dashboard.status_code))
                continue
            body = dashboard.json()
            cards = {}
            for dashcard in body.get("dashcards") or []:
                card_id = dashcard.get("card_id")
                if card_id is None:
                    continue
                time.sleep(0.2)
                url = f"{METABASE}{token}/dashcard/{dashcard['id']}/card/{card_id}"
                result = requests.get(url, timeout=120)
                if result.status_code >= 300:
                    log.warning("metabase card %s: %d", card_id, result.status_code)
                    continue
                data = result.json()
                cards[str(card_id)] = {"name": (dashcard.get("card") or {}).get("name"), "result": data}
                log.info("metabase %s card %s: %s rows", body.get("id"), card_id, data.get("row_count"))
            # A per-campaign embed reuses one dashboard id, so the campaign keys the file.
            payload = token.split(".")[1]
            params = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("params") or {}
            key = str(body.get("id"))
            if params.get("campaignid"):
                campaign = params["campaignid"]
                key = f"{key}_campaign_{campaign[0] if isinstance(campaign, list) else campaign}"
            name = f"metabase_{key}"
            target = folder / f"{key}.json"
            target.write_text(json.dumps({"dashboard": body, "cards": cards}, ensure_ascii=False))
            self.finish(name, target, "metabase embed dashboard", len(cards))

    def assets(self):
        """Download images hosted by Qomon's vendors; contact data is not scanned."""
        folder = self.root / "assets"
        folder.mkdir(exist_ok=True)
        index = self.root / "assets_index.jsonl"
        seen = set()
        if index.exists():
            with index.open(encoding="utf-8") as f:
                seen = {json.loads(line)["url"] for line in f}
        urls = set()
        for path in [*(self.root / "reference").glob("*.json"), *(self.root / "details").glob("*.jsonl")]:
            urls |= set(ASSET_URL.findall(path.read_text(encoding="utf-8")))
        log.info("start assets: %d urls, %d already tried", len(urls), len(seen))
        failures = 0
        with index.open("a", encoding="utf-8") as f:
            for url in sorted(urls - seen):
                time.sleep(0.2)
                try:
                    # Plain request: the API key must not reach these hosts.
                    response = requests.get(url, timeout=60)
                    status = response.status_code
                except requests.RequestException:
                    response, status = None, 0
                entry = {"url": url, "status": status}
                if status == 200:
                    digest = hashlib.sha256(response.content).hexdigest()
                    (folder / digest).write_bytes(response.content)
                    entry |= {"file": f"assets/{digest}", "type": response.headers.get("content-type")}
                else:
                    failures += 1
                f.write(json.dumps(entry) + "\n")
                f.flush()
        log.info("end assets: %d urls, %d failures", len(urls), failures)

    def verify(self):
        problems = 0
        for name, entry in self.manifest["files"].items():
            path = self.root / entry["file"]
            if sha256(path) != entry["sha256"]:
                problems += 1
                log.error("checksum mismatch: %s", name)
            if path.suffix == ".jsonl":
                with path.open(encoding="utf-8") as f:
                    lines = sum(1 for line in f if json.loads(line))
                if lines != entry["records"]:
                    problems += 1
                    log.error("%s: %d lines, manifest says %d", name, lines, entry["records"])
            elif path.suffix == ".json":
                json.loads(path.read_text())
        log.info("verified %d files, %d problems, %d failed endpoints", len(self.manifest["files"]), problems,
                 len(self.manifest["failed"]))

    def seal(self):
        names = sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob("*")
                       if p.is_file() and p.name not in ("HASHES.sha256", ".DS_Store"))
        lines = [f"{sha256(self.root / name)}  {name}\n" for name in names]
        (self.root / "HASHES.sha256").write_text("".join(lines), encoding="utf-8")
        log.info("sealed %d files", len(names))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", type=Path)
    parser.add_argument(
        "--stages", default="contacts,lists,details,per-contact,contact-details,segments,metabase,assets"
    )
    parser.add_argument("--only", help="comma-separated list and detail names")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--contact-limit", type=int, help="per-contact stage: test on this many contacts")
    parser.add_argument("--contact-scope", choices=["activity", "sample", "all"], default="activity")
    parser.add_argument("--verify", action="store_true", help="recheck the archive; no API calls")
    parser.add_argument("--seal", action="store_true", help="write HASHES.sha256; no API calls")
    parser.add_argument("--requests-per-second", type=float, default=5)
    parser.add_argument("--workers", type=int, default=1, help="parallel requests in per-id stages")
    args = parser.parse_args()

    folder = args.out.resolve()
    if any((p / ".git").exists() for p in [folder, *folder.parents]):
        parser.error("the archive holds personal data; put it outside any git work tree")
    args.out.mkdir(parents=True, exist_ok=True)
    offline = args.verify or args.seal
    # Offline runs log to the console only, so they never change a sealed archive.
    handlers = [logging.StreamHandler()] + ([] if offline else [logging.FileHandler(args.out / "archive.log")])
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)
    if offline:
        archive = Archive(args.out, None, False)
        if args.verify:
            archive.verify()
        if args.seal:
            archive.seal()
        return
    key = sys.stdin.read().strip()
    if not key:
        parser.error("pipe the Qomon API key on stdin")
    archive = Archive(args.out, Api(key, args.requests_per_second, args.workers), args.retry_failed, args.workers)
    stages = args.stages.split(",")
    only = set(args.only.split(",")) if args.only else None
    if "contacts" in stages:
        archive.contacts()
    if "lists" in stages:
        archive.lists(only)
    if "details" in stages:
        archive.details(only)
    if "per-contact" in stages:
        archive.per_contact(args.contact_limit, args.contact_scope)
    if "contact-details" in stages:
        archive.contact_details()
    if "segments" in stages:
        archive.segments()
    if "metabase" in stages:
        archive.metabase()
    if "assets" in stages:
        archive.assets()


if __name__ == "__main__":
    main()
