"""Every fixture must be a valid output of the real pipeline, and the bundle the frontend
ships must match what the pipeline produces today."""

from __future__ import annotations

import json
import math
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from app.assess import AssessmentRun, all_rules, normalize_column_call
from app.dataset import Dataset
from app.demo import FIXTURE_DIR
from app.main import app
from app.profiler import Profile
from app.rules import rule_id, run_rule, validate_rule
from scripts import export_demo, placeholder_fixture

ROOT_FIXTURES = Path(__file__).resolve().parent.parent.parent / "fixtures"
STORES = sorted(p for p in FIXTURE_DIR.glob("*.json") if p.name != "presets.json")


def fixtures() -> list[tuple[str, str, dict[str, Any]]]:
    return [
        (path.stem, key, fixture)
        for path in STORES
        for key, fixture in json.loads(path.read_text()).items()
    ]


def test_there_is_a_fixture_store() -> None:
    assert [path.name for path in STORES] == ["assess.json"]


@pytest.mark.parametrize(("store", "key", "fixture"), fixtures())
def test_fixture_is_a_valid_run_of_the_real_pipeline(
    store: str, key: str, fixture: dict[str, Any], sample: Dataset, profile: Profile, as_of: date
) -> None:
    run = AssessmentRun.model_validate(fixture["data"])
    assert [a.column for a in run.assessments] == profile.column_names()
    for assessment in run.assessments:
        # Re-normalizing the stored assessment through the live code path changes nothing.
        raw = assessment.model_dump()
        raw["rules"] = [
            {"rule": r["rule"], "severity": r["severity"], "reason": r["reason"]}
            for r in raw["rules"]
        ] + [{"rule": r["rule"], "severity": "error", "reason": ""} for r in raw["rejected_rules"]]
        again = normalize_column_call(raw, profile, assessment.column)
        assert again.rules == assessment.rules
        assert [r.reason for r in again.rejected_rules] == [r.reason for r in assessment.rejected_rules]  # fmt: skip
        assert assessment.business_definition and assessment.rationale
    rules = all_rules(run)
    assert len(rules) == len({r.id for r in rules}) >= 25
    for proposed in rules:
        rule = validate_rule(proposed.rule, sample.columns)
        assert rule == proposed.rule and rule_id(rule) == proposed.id
        result = run_rule(sample, rule, as_of=as_of)
        assert result.status in ("pass", "fail") and result.error is None
    known = set(profile.column_names())
    for relationship in run.relationships:
        assert set(relationship.columns) <= known and relationship.description

    # The recorded events replay to the same final state.
    events = [item["event"] for item in fixture["events"]]
    columns = [e["assessment"] for e in events if e["type"] == "column"]
    assert columns == fixture["data"]["assessments"]
    (relationships,) = [e["relationships"] for e in events if e["type"] == "relationships"]
    assert relationships == fixture["data"]["relationships"]
    assert [item["at"] for item in fixture["events"]] == sorted(i["at"] for i in fixture["events"])


@pytest.mark.parametrize(("store", "key", "fixture"), fixtures())
def test_placeholders_are_marked_and_claim_no_usage(
    store: str, key: str, fixture: dict[str, Any], profile: Profile
) -> None:
    if not fixture["placeholder"]:
        assert fixture["recordedAt"] and fixture["costUsd"] > 0
        return
    assert fixture["recordedAt"] is None and fixture["costUsd"] == 0
    assert set(fixture["usage"].values()) == {0}
    assert all(p["cost_usd"] == 0 for p in fixture["data"]["passes"])
    # The committed JSON is exactly what the hand-written source produces.
    expected = placeholder_fixture.build_fixture(placeholder_fixture.build_run(profile))
    assert fixture == json.loads(json.dumps(expected))


def test_presets_cover_every_fixture_and_both_copies_agree() -> None:
    presets = json.loads((FIXTURE_DIR / "presets.json").read_text())
    assert presets == json.loads((ROOT_FIXTURES / "presets.json").read_text())
    routes = {route.path for route in app.routes}  # type: ignore[attr-defined]
    assert {p["route"] for p in presets} <= routes
    recorded = {key for _, key, _ in fixtures()}
    assert {p["body"]["demoId"] for p in presets} == recorded


def approx_equal(a: Any, b: Any) -> bool:
    if isinstance(a, float) or isinstance(b, float):
        return isinstance(a, int | float) and isinstance(b, int | float) and math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-6)  # fmt: skip
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(approx_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(approx_equal(x, y) for x, y in zip(a, b, strict=True))
    return bool(a == b)


def test_frontend_bundle_is_up_to_date_with_the_pipeline() -> None:
    committed = json.loads((ROOT_FIXTURES / "demo.json").read_text())
    rebuilt = json.loads(json.dumps(export_demo.build_bundle()))
    assert committed.keys() == rebuilt.keys()
    for section in committed:
        assert approx_equal(committed[section], rebuilt[section]), (
            f"fixtures/demo.json is stale in '{section}': run `uv run python -m scripts.export_demo`"
        )
    fixture = json.loads((FIXTURE_DIR / "assess.json").read_text())["sample-loans"]
    assert committed["meta"]["placeholder"] == fixture["placeholder"]
    run = AssessmentRun.model_validate(fixture["data"])
    assert set(committed["results"]) == {rule.id for rule in all_rules(run)}
    assert len(committed["planted"]) == 17
    if fixture["placeholder"]:
        # The hand-written sample proposes a rule for every planted issue.
        assert all(issue["suggested"] for issue in committed["planted"])
