"""Rebuild a Qomon archive as SQLite. Standard library only; no network.

    python restore_archive.py <archive_dir> <output.sqlite>

Stops if a file fails HASHES.sha256, if the archive has an unlisted file, or if
the output is inside a git work tree or on an unencrypted disk. Prints counts only.
"""

import argparse
import hashlib
import json
import platform
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

HASH_FILE = "HASHES.sha256"
EXCLUDED = {
    HASH_FILE: "hash list; applied before loading",
    "README.md": "instructions, not data",
    "archive.log": "export log, counts only; appended by --verify",
}
HISTORY_TYPES = {
    "import": ["ImportID", "Name"],
    "fact": ["type", "status"],
    "formdatas": [],
    "email": ["id", "campaign_id", "status", "subject"],
    "customfield": ["id", "form_id", "form_ref_id"],
    "sms": ["id", "campainid", "status"],
    "participation": ["action_id", "confirmed_at", "declined_at", "checked_in_at"],
    "online_form": ["type", "signed_at"],
    "interaction": ["id", "type", "date_of_event"],
    "note": ["id", "created_at"],
}


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_hashes(root):
    listed = {}
    for line in (root / HASH_FILE).read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        listed[name] = digest
    actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()} - {HASH_FILE}
    problems = sorted(actual ^ set(listed))
    problems += sorted(n for n in actual & set(listed) if sha256(root / n) != listed[n])
    if problems:
        sys.exit(f"hash check failed for {len(problems)} files, first: {problems[0]}")
    print(f"hashes: {len(listed)} files verified")
    return sorted(listed)


def check_output(path):
    folder = path.resolve().parent
    if any((p / ".git").exists() for p in [folder, *folder.parents]):
        sys.exit("refusing to write inside a git work tree")
    if platform.system() != "Darwin":
        sys.exit("encryption check is macOS only; on other systems adapt check_output")
    device = subprocess.run(["/bin/df", "-P", str(folder)], capture_output=True, text=True).stdout.splitlines()[-1].split()[0]
    info = subprocess.run(["/usr/sbin/diskutil", "info", device], capture_output=True, text=True).stdout
    if not re.search(r"(FileVault|Encrypted):\s+Yes", info):
        sys.exit("refusing to write to an unencrypted disk")


def biggest_list(value):
    if isinstance(value, list):
        return value
    best = []
    if isinstance(value, dict):
        for item in value.values():
            found = biggest_list(item)
            if len(found) > len(best):
                best = found
    return best


def lines(path):
    with path.open(encoding="utf-8") as f:
        for number, line in enumerate(f, 1):
            yield number, json.loads(line)


def body(response):
    return response.get("data", response) if isinstance(response, dict) else response


class Loader:
    def __init__(self, root, db):
        self.root, self.db, self.created = root, db, set()
        self.contact_ids = {r["id"] for _, r in lines(root / "contacts.jsonl")}

    def insert(self, table, row):
        if table not in self.created:
            names = ", ".join(f'"{c}"' for c in row)
            self.db.execute(f'CREATE TABLE "{table}" ({names})')
            self.created.add(table)
        marks = ", ".join("?" * len(row))
        values = [canonical(v) if isinstance(v, (dict, list)) else v for v in row.values()]
        self.db.execute(f'INSERT INTO "{table}" VALUES ({marks})', values)

    def table(self, table, name, id_of=lambda r: r.get("id"), extra=lambda r: {}):
        source = json.loads((self.root / name).read_text(encoding="utf-8"))
        for record in biggest_list(source):
            self.insert(table, {"id": id_of(record), **extra(record), "raw": canonical(record)})

    def per_id(self, table, name):
        for number, record in lines(self.root / name):
            self.insert(table, {"id": record["id"], "source_line": number, "raw": canonical(record)})

    def contacts(self):
        forms = [f for name in ("forms", "forms_survey") for f in biggest_list(
            json.loads((self.root / f"reference/{name}.json").read_text(encoding="utf-8")))]
        form_ids = {f["id"] for f in forms}
        ref_ids = {r.get("id") for f in forms for r in f.get("refvalues") or []}
        for number, record in lines(self.root / "contact_details.jsonl"):
            contact_id, contact = record["id"], body(record["response"]).get("contact") or {}
            self.insert("contacts", {"id": contact_id, "source_line": number, "raw": canonical(record)})
            for tag in contact.get("tags") or []:
                self.insert("contact_tags", {"contact_id": contact_id, "name": tag.get("name"), "raw": canonical(tag)})
            for field in contact.get("custom_fields") or []:
                self.insert("contact_custom_fields", {"contact_id": contact_id, "form_id": field.get("form_id"),
                                                      "raw": canonical(field)})
            for answer in contact.get("formdatas") or []:
                self.insert("survey_answers", {"contact_id": contact_id, "form_id": answer.get("form_id"),
                                               "form_ref_id": answer.get("form_ref_id"),
                                               "fact_id": answer.get("fact_id"),
                                               "dangling_form": int(answer.get("form_id") not in form_ids),
                                               "dangling_ref": int(answer.get("form_ref_id") not in ref_ids),
                                               "raw": canonical(answer)})
        for number, record in lines(self.root / "contacts.jsonl"):
            self.insert("contacts_search", {"id": record["id"], "source_line": number, "raw": canonical(record)})
        for number, record in lines(self.root / "contact_notes.jsonl"):
            self.insert("contact_notes_raw", {"id": record["id"], "source_line": number, "raw": canonical(record)})
            for note in biggest_list(record["response"]):
                self.insert("notes", {"id": note.get("id"), "contact_id": record["id"], "raw": canonical(note)})

    def history(self, action_ids):
        for number, record in lines(self.root / "contact_history.jsonl"):
            self.insert("contact_history_raw", {"id": record["id"], "source_line": number,
                                                "status": record["response"].get("status"),
                                                "event_count": len(record["response"].get("data") or [])})
            for position, event in enumerate(record["response"].get("data") or []):
                kinds = [k for k in event if k != "date_for_ordering"]
                kind = kinds[0] if kinds and kinds[0] in HISTORY_TYPES else "other"
                detail = event.get(kind) if isinstance(event.get(kind), dict) else {}
                row = {"contact_id": record["id"], "position": position, "date_for_ordering": event.get("date_for_ordering")}
                row |= {c: detail.get(c) for c in HISTORY_TYPES.get(kind, [])}
                if kind == "participation":
                    row["dangling_action"] = int(detail.get("action_id") not in action_ids)
                self.insert(f"history_{kind}", {**row, "raw": canonical(event)})

    def segments(self):
        for number, record in lines(self.root / "segments.jsonl"):
            rest = {k: v for k, v in record.items() if k != "contact_ids"}
            self.insert("segments", {"id": number, "kind": record["kind"], "source_id": str(record["source_id"]),
                                     "kpi_total": record.get("kpi_total"), "raw": canonical(rest)})
            for position, contact_id in enumerate(record["contact_ids"]):
                self.insert("segment_contacts", {"segment_id": number, "position": position, "contact_id": contact_id,
                                                 "dangling": int(contact_id not in self.contact_ids)})

    def files(self, names):
        for folder, table in (("documents", "documents"), ("assets", "assets")):
            for name in names:
                if name.startswith(folder + "/") and name != "documents/index.json":
                    data = (self.root / name).read_bytes()
                    self.insert(table, {"path": name, "sha256": hashlib.sha256(data).hexdigest(),
                                        "bytes": len(data), "content": data})

    def everything_else(self, names):
        for name in names:
            path = self.root / name
            if name in EXCLUDED:
                status, reason = "excluded", EXCLUDED[name]
            elif name.startswith(("assets/",)) or (name.startswith("documents/") and name != "documents/index.json"):
                status, reason = "loaded", "file table"
            elif name.startswith("tools/"):
                status, reason = "loaded", "stored as text in archive_files"
                self.insert("archive_files", {"file": name, "line": 0, "raw": path.read_text(encoding="utf-8")})
            elif name.endswith(".jsonl"):
                status, reason = "loaded", "archive_files, one row per line"
                for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                    if name not in ("contacts.jsonl", "contact_details.jsonl", "contact_history.jsonl",
                                    "contact_notes.jsonl", "segments.jsonl"):
                        self.insert("archive_files", {"file": name, "line": number, "raw": canonical(json.loads(line))})
            else:
                status, reason = "loaded", "archive_files, whole file"
                self.insert("archive_files", {"file": name, "line": 0, "raw": canonical(json.loads(path.read_text(encoding="utf-8")))})
            self.insert("load_coverage", {"file": name, "status": status, "reason": reason})


def action_id(record):
    action = record.get("Action") or {}
    return action.get("ID") or action.get("id")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    names = verify_hashes(args.archive)
    check_output(args.output)
    args.output.unlink(missing_ok=True)
    db = sqlite3.connect(args.output)
    db.execute("PRAGMA journal_mode=OFF")
    loader = Loader(args.archive, db)
    loader.contacts()
    actions = json.loads((args.archive / "reference/actions.json").read_text(encoding="utf-8"))
    loader.history({action_id(r) for r in biggest_list(actions)})
    loader.segments()
    loader.table("actions", "reference/actions.json", action_id)
    loader.per_id("action_details", "details/action.jsonl")
    loader.per_id("email_campaigns", "details/emailer_campaign.jsonl")
    loader.per_id("email_campaign_kpis", "details/emailer_campaign_kpi_v2.jsonl")
    loader.table("forms", "reference/forms.json")
    loader.table("forms_survey", "reference/forms_survey.json")
    loader.table("online_forms", "reference/online_forms.json")
    loader.table("surveys", "reference/surveys.json")
    for table in ("donations", "transactions", "transaction_bundles", "users", "teams_with_users"):
        extra = {"donations": lambda r: {"contact_id": r["contact_id"], "amount": r["amount"]},
                 "transactions": lambda r: {"contact_id": r["contact_id"], "amount": r["amount"],
                                            "bundle_id": r["transaction_bundle_id"]}}.get(table, lambda r: {})
        loader.table(table, f"reference/{table}.json", extra=extra)
    loader.files(names)
    loader.everything_else(names)
    db.commit()
    for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
        print(table, db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0])
    db.close()


if __name__ == "__main__":
    main()
