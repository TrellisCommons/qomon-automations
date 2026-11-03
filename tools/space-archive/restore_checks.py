"""Prove a restored SQLite file matches its archive. Standard library only.

    python restore_checks.py <archive_dir> <output.sqlite>

Prints pass or fail with counts only; exits 1 on any failure.
"""

import json
import re
import sqlite3
import sys

sys.dont_write_bytecode = True

from collections import Counter
from pathlib import Path

from restore_archive import action_id, biggest_list, body, canonical, lines

failures = 0


def check(name, actual, expected):
    global failures
    ok = actual == expected
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'} {name}: {actual if isinstance(actual, (int, str)) else 'compared'}"
          + ("" if ok or not isinstance(expected, (int, str)) else f" expected {expected}"))


def raw_of(db, table, order="rowid"):
    return [r[0] for r in db.execute(f'SELECT raw FROM "{table}" ORDER BY {order}')]


def main():
    root, db = Path(sys.argv[1]), sqlite3.connect(sys.argv[2])
    sql = (Path(__file__).parent / "restore_queries.sql").read_text()
    for name, expected, query in re.findall(r"^-- (\w+)(?: \| (\d+))?\n(.+?;)$", sql, re.M | re.S):
        value = db.execute(query).fetchone()[0]
        if expected:
            check(name, value, int(expected))
        else:
            print(f"INFO {name}: {value}")

    for table, name in (("contacts", "contact_details.jsonl"), ("contacts_search", "contacts.jsonl"),
                        ("contact_notes_raw", "contact_notes.jsonl")):
        check(f"raw {table}", raw_of(db, table), [canonical(r) for _, r in lines(root / name)])
    for table, name in (("actions", "actions"), ("donations", "donations"), ("transactions", "transactions"),
                        ("transaction_bundles", "transaction_bundles"), ("users", "users"), ("forms", "forms")):
        source = json.loads((root / f"reference/{name}.json").read_text(encoding="utf-8"))
        check(f"raw {table}", raw_of(db, table), [canonical(r) for r in biggest_list(source)])

    rebuilt = {}
    for kind_table in [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE name LIKE 'history\\_%' ESCAPE '\\'")]:
        for contact_id, position, raw in db.execute(f'SELECT contact_id, position, raw FROM "{kind_table}"'):
            rebuilt.setdefault(contact_id, {})[position] = raw
    mismatch = 0
    for _, record in lines(root / "contact_history.jsonl"):
        events = [canonical(e) for e in record["response"].get("data") or []]
        have = rebuilt.get(record["id"], {})
        mismatch += events != [have.get(i) for i in range(len(have))]
    check("raw history contacts differing", mismatch, 0)

    bad = 0
    for number, record in lines(root / "segments.jsonl"):
        ids = [r[0] for r in db.execute("SELECT contact_id FROM segment_contacts WHERE segment_id=? ORDER BY position", (number,))]
        bad += ids != record["contact_ids"]
    check("segment contact lists differing", bad, 0)

    check("contact ids appearing twice", db.execute("SELECT count(*) FROM (SELECT id FROM contacts GROUP BY id HAVING count(*)>1)").fetchone()[0], 0)
    files = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()} - {"HASHES.sha256"}
    check("source files not in coverage", len(files ^ {r[0] for r in db.execute("SELECT file FROM load_coverage")}) , 0)

    only = Counter()
    details = {r["id"]: body(r["response"]).get("contact") or {} for _, r in lines(root / "contact_details.jsonl")}
    for _, record in lines(root / "contacts.jsonl"):
        only.update(k for k, v in record.items() if v not in (None, "", [], {}) and k not in details[record["id"]])
    print("INFO fields only in contacts.jsonl:", dict(only))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
