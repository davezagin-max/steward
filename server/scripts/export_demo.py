"""Precompute everything the Next.js app needs to run with no API at all.

    uv run python -m scripts.export_demo

Reads the sample CSV and the suggestions in `fixtures/assess.json` (hand-written
placeholders, or a recorded run after `scripts/record.py`), then writes
`../fixtures/demo.json`, which the frontend bundles:

- the deterministic profile and the masked view of it that the model sees,
- the suggestions, every rule re-validated by the real validator,
- the result of running every suggested rule with the real engine,
- the rule catalog the edit forms are generated from,
- the planted-issue answer key, without row numbers.

The deployed site therefore works when this API is cold or down.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.assess import AssessmentRun, all_rules
from app.dataset import MANIFEST_PATH, SAMPLE_NAME, load_sample
from app.main import key_columns, sample_as_of
from app.profiler import model_view, profile_dataset
from app.rules import catalog_json, rule_id, run_rule, validate_rule

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = ROOT / "fixtures" / "assess.json"
BUNDLE_PATH = ROOT.parent / "fixtures" / "demo.json"
# A frozen copy of the placeholder bundle for the frontend's unit tests, so they keep
# passing after a real run replaces the placeholder suggestions.
SNAPSHOT_PATH = ROOT.parent / "tests" / "steward" / "fixtures" / "placeholder-bundle.json"
DEMO_ID = "sample-loans"


def build_bundle() -> dict[str, Any]:
    fixture = json.loads(FIXTURE_PATH.read_text())[DEMO_ID]
    manifest = json.loads(MANIFEST_PATH.read_text())
    as_of = sample_as_of()
    dataset = load_sample()
    try:
        profile = profile_dataset(dataset, as_of)
        run = AssessmentRun.model_validate(fixture["data"])
        context = key_columns(profile)
        results: dict[str, Any] = {}
        for proposed in all_rules(run):
            # Fails loudly if a fixture rule is not valid for the real dataset.
            rule = validate_rule(proposed.rule, dataset.columns)
            if rule_id(rule) != proposed.id:
                raise RuntimeError(f"Fixture rule id does not match its content: {proposed.id}")
            result = run_rule(dataset, rule, as_of=as_of, context_columns=context)
            if result.status == "error":
                raise RuntimeError(f"Fixture rule {proposed.id} did not run: {result.error}")
            results[proposed.id] = result.model_dump()
        suggested = set(results)
        planted = [
            {
                "id": issue["id"],
                "kind": issue["kind"],
                "columns": issue["columns"],
                "description": issue["description"],
                "count": issue["count"],
                "rule_id": rule_id(validate_rule(issue["rule"], dataset.columns)),
                "suggested": rule_id(validate_rule(issue["rule"], dataset.columns)) in suggested,
            }
            for issue in manifest["issues"]
        ]
    finally:
        dataset.close()

    return {
        "meta": {
            "mode": "demo",
            "placeholder": fixture["placeholder"],
            "recordedAt": fixture["recordedAt"],
            "model": fixture["model"],
            "usage": fixture["usage"],
            "costUsd": fixture["costUsd"],
        },
        "dataset": {
            "id": DEMO_ID,
            "name": SAMPLE_NAME,
            "title": "Mortgage loan tape (synthetic)",
            "as_of": as_of.isoformat(),
            "key_columns": context,
            "synthetic": True,
        },
        "profile": profile.model_dump(),
        "model_view": model_view(profile),
        "run": run.model_dump(),
        "results": results,
        "catalog": catalog_json(),
        "planted": planted,
    }


def main() -> None:
    bundle = build_bundle()
    BUNDLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    BUNDLE_PATH.write_text(json.dumps(bundle, indent=1, ensure_ascii=False) + "\n")
    if bundle["meta"]["placeholder"]:
        SNAPSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT_PATH.write_text(
            json.dumps(bundle, separators=(",", ":"), ensure_ascii=False) + "\n"
        )
    failing = sum(1 for result in bundle["results"].values() if result["status"] == "fail")
    caught = sum(1 for issue in bundle["planted"] if issue["suggested"])
    print(
        f"wrote {BUNDLE_PATH} ({BUNDLE_PATH.stat().st_size // 1024} KB): "
        f"{len(bundle['results'])} rules run, {failing} failing, "
        f"{caught}/{len(bundle['planted'])} planted issues matched by a suggested rule"
    )


if __name__ == "__main__":
    main()
