"""The bundled sample is reproducible, clearly fake, and matches its manifest."""

import csv
import io
import re
from typing import Any

from app.dataset import MANIFEST_PATH, SAMPLE_PATH
from scripts.generate_sample import BASE_ROWS, COLUMNS, build


def test_generator_is_deterministic_and_matches_the_committed_files() -> None:
    first, second = build(), build()
    assert first.csv_text == second.csv_text
    assert first.csv_text == SAMPLE_PATH.read_text(encoding="utf-8")
    assert first.manifest == __import__("json").loads(MANIFEST_PATH.read_text())


def test_identifiers_are_in_invalid_or_reserved_ranges() -> None:
    rows = list(csv.DictReader(io.StringIO(SAMPLE_PATH.read_text(encoding="utf-8"))))
    assert len(rows) == BASE_ROWS + 14
    assert list(rows[0]) == COLUMNS
    for row in rows:
        # Area 900-999 with group 00 is never issued as an SSN or an ITIN.
        assert re.fullmatch(r"9\d{2}-?00-?\d{4}", row["borrower_ssn"])
        email = row["borrower_email"]
        assert email == "" or email.split("@")[1] in {"example.com", "example.org", "example.net"}
        assert re.fullmatch(r"LN\d{8}", row["loan_id"])


def test_manifest_lists_every_issue_family_from_the_spec(manifest: dict[str, Any]) -> None:
    kinds = {issue["kind"] for issue in manifest["issues"]}
    assert {"nulls", "bad_dates", "duplicate_keys", "inconsistent_codes"} <= kinds
    counts = {issue["id"]: issue["count"] for issue in manifest["issues"]}
    assert counts["duplicate_loan_id"] == 28
    assert counts["first_payment_unparseable"] == 18
    assert counts["occupancy_code_variants"] == 40
    assert counts["mi_coverage_missing"] == 23
    assert all(issue["count"] == len(issue["rows"]) > 0 for issue in manifest["issues"])
