"""Rule DSL tests: the validator, the SQL compiler's safety, and the engine's answers."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from app.dataset import ROW, TABLE, Dataset
from app.rules import (
    CATALOG,
    MAX_SET_VALUES,
    RuleError,
    catalog_json,
    compile_rule,
    echo_safe,
    failing_rows,
    rule_columns,
    rule_id,
    rule_wire_schema,
    run_rule,
    run_rules,
    validate_rule,
)
from tests.conftest import make_dataset

AS_OF = date(2025, 9, 30)
COLUMNS = ["id", "code", "label", "amount", "base", "pct", "opened", "closed"]


def table() -> Dataset:
    return make_dataset(
        COLUMNS,
        [
            # id,  code, label,   amount,  base,  pct,     opened,       closed
            ("A1", "P", "Primary", "100", "200", "50.00", "2024-01-10", "2024-02-01"),
            ("A2", "P", "Primary", "250", "500", "50.00", "2024-03-05", "2024-03-05"),
            ("A3", "S", "Second", "-5", "100", "-5.00", "2026-01-01", "2026-02-01"),
            ("A3", "S", "Primary", "abc", "0", "10.00", "2024-05-01", "2024-04-01"),
            ("A5", "x", "Other", "900", "300", "310.00", "2024-02-30", "2024-06-01"),
            (None, None, None, None, None, None, None, None),
        ],
    )


# ----------------------------------------------------------------- validator


def test_valid_rules_come_back_in_canonical_form() -> None:
    rule = validate_rule({"max": 850.0, "column": "amount", "type": "range", "min": 300}, COLUMNS)
    assert rule == {"type": "range", "column": "amount", "min": 300, "max": 850}
    assert list(rule) == ["type", "column", "min", "max"]
    assert isinstance(rule["max"], int)
    one_sided = validate_rule({"type": "range", "column": "amount", "min": 0}, COLUMNS)
    assert one_sided["max"] is None
    # The id depends on content only, not on key order or 850 versus 850.0.
    assert rule_id(rule) == rule_id(
        validate_rule({"type": "range", "column": "amount", "min": 300.0, "max": 850}, COLUMNS)
    )
    assert rule_id(rule) != rule_id(one_sided)


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ("DROP TABLE dataset", "must be an object"),
        ({"type": "sql", "query": "SELECT 1"}, "Unknown rule type"),
        ({"type": "not_null"}, "Missing field 'column'"),
        ({"type": "not_null", "column": "missing"}, "Unknown column 'missing'"),
        ({"type": "not_null", "column": 'id" IS NULL OR 1=1 --'}, "Unknown column"),
        ({"type": "not_null", "column": ["id"]}, "must be a column name"),
        ({"type": "not_null", "column": "id", "where": "1=1"}, "Unexpected field"),
        ({"type": "unique", "columns": []}, "1 to 4 columns"),
        ({"type": "unique", "columns": ["id", "id"]}, "repeats a column"),
        ({"type": "unique", "columns": ["id", "code", "label", "amount", "base"]}, "1 to 4"),
        ({"type": "in_set", "column": "code", "values": []}, "1 to 200 values"),
        ({"type": "in_set", "column": "code", "values": ["P", 3]}, "non-empty string"),
        ({"type": "in_set", "column": "code", "values": ["P", "P"]}, "repeats a value"),
        ({"type": "in_set", "column": "code", "values": ["x" * 101]}, "longer than 100"),
        (
            {"type": "in_set", "column": "code", "values": [str(n) for n in range(MAX_SET_VALUES + 1)]},
            "1 to 200 values",
        ),
        ({"type": "range", "column": "amount", "min": None, "max": None}, "needs a minimum"),
        ({"type": "range", "column": "amount", "min": 10, "max": 1}, "greater than the maximum"),
        ({"type": "range", "column": "amount", "min": "0; DROP", "max": 1}, "finite number"),
        ({"type": "range", "column": "amount", "min": float("nan"), "max": 1}, "finite number"),
        ({"type": "range", "column": "amount", "min": True, "max": 1}, "finite number"),
        ({"type": "regex", "column": "id", "pattern": "(("}, "not a valid RE2"),
        ({"type": "regex", "column": "id", "pattern": "a" * 201}, "longer than 200"),
        ({"type": "regex", "column": "id", "pattern": ""}, "non-empty string"),
        ({"type": "parses_as", "column": "opened", "as_type": "timestamp"}, "must be one of"),
        (
            {"type": "date_order", "before_column": "opened", "after_column": "opened", "allow_equal": True},
            "must be different columns",
        ),
        (
            {"type": "date_order", "before_column": "opened", "after_column": "closed", "allow_equal": "yes"},
            "true or false",
        ),
        (
            {"type": "derived_ratio", "column": "pct", "numerator_column": "amount",
             "denominator_column": "base", "multiplier": 0, "tolerance": 0.01},
            "cannot be zero",
        ),
        (
            {"type": "derived_ratio", "column": "pct", "numerator_column": "amount",
             "denominator_column": "base", "multiplier": 100, "tolerance": -1},
            "cannot be negative",
        ),
    ],
)  # fmt: skip
def test_invalid_rules_are_rejected_before_any_sql_exists(raw: Any, message: str) -> None:
    with pytest.raises(RuleError, match=message):
        validate_rule(raw, COLUMNS)


def test_every_catalog_type_is_covered_by_the_wire_schema_and_stays_within_strict_limits() -> None:
    schema = rule_wire_schema(COLUMNS)
    assert [b["properties"]["type"]["enum"][0] for b in schema["anyOf"]] == list(CATALOG)
    unions = 1  # the anyOf itself
    for branch in schema["anyOf"]:
        assert branch["additionalProperties"] is False
        assert branch["required"] == list(branch["properties"])
        for prop in branch["properties"].values():
            assert not {
                "minimum",
                "maximum",
                "minLength",
                "maxLength",
                "minItems",
                "pattern",
            } & set(prop)
            unions += isinstance(prop.get("type"), list)
    assert unions <= 8  # two tools carry this schema; the API allows 16 union-typed parameters
    column_field = schema["anyOf"][0]["properties"]["column"]
    assert column_field == {"type": "string", "enum": COLUMNS}
    assert [t["type"] for t in catalog_json()] == list(CATALOG)


# ----------------------------------------------------------------- compiler safety

HOSTILE = [
    'x"; DROP TABLE dataset; --',
    "a'b",
    'quote"inside',
    "semi;colon",
    "sp ace",
    "SELECT",
    "naïve ☃",
    "$1",
    "back\\slash",
]


def hostile_rules() -> list[dict[str, Any]]:
    a, b, c, d = HOSTILE[0], HOSTILE[1], HOSTILE[2], HOSTILE[3]
    return [
        {"type": "not_null", "column": a},
        {"type": "unique", "columns": [a, b]},
        {"type": "in_set", "column": b, "values": ["P", "'); DROP TABLE dataset; --"]},
        {"type": "range", "column": c, "min": 0, "max": 500},
        {"type": "regex", "column": a, "pattern": "[A-Z][0-9]'\"; --"},
        {"type": "parses_as", "column": d, "as_type": "date"},
        {"type": "date_not_future", "column": d},
        {"type": "date_order", "before_column": d, "after_column": HOSTILE[4], "allow_equal": False},
        {"type": "conditional_not_null", "column": HOSTILE[5], "when_column": b, "when_values": ["P", "P' OR '1'='1"]},
        {"type": "reference_consistency", "key_column": b, "dependent_column": HOSTILE[6]},
        {
            "type": "derived_ratio",
            "column": HOSTILE[7],
            "numerator_column": c,
            "denominator_column": HOSTILE[8],
            "multiplier": 100,
            "tolerance": 0.01,
        },
    ]  # fmt: skip


def test_hostile_column_names_and_values_cannot_change_the_query() -> None:
    injection = "'); DROP TABLE dataset; --"
    dataset = make_dataset(
        HOSTILE,
        [
            ("A1", "P", "100", "2024-01-10", "2024-02-01", "y", "Primary", "50", "200"),
            ("A1", "P", "900", "2024-02-30", "2024-01-01", None, "Second", "10", "100"),
            (None, injection, "abc", "2030-01-01", "2029-01-01", "y", "x", "1", "0"),
        ],
    )
    rules = hostile_rules()
    assert {rule["type"] for rule in rules} == set(CATALOG)
    results = run_rules(dataset, rules, as_of=AS_OF)
    assert [r.error for r in results] == [None] * len(rules)
    assert {r.rule["type"]: (r.evaluated, r.failed) for r in results} == {
        "not_null": (3, 1),
        "unique": (2, 2),
        # The injection text is just one more allowed value, compared as data.
        "in_set": (3, 0),
        "range": (2, 1),
        "regex": (2, 2),
        "parses_as": (3, 1),
        "date_not_future": (2, 1),
        "date_order": (2, 1),
        "conditional_not_null": (2, 1),
        "reference_consistency": (3, 1),
        "derived_ratio": (2, 1),
    }
    # Samples read the hostile columns back by name.
    assert results[0].samples[0].values == {HOSTILE[0]: None}
    # The table and its rows are untouched, and nothing else was created.
    assert dataset.con.execute(f"SELECT count(*) FROM {TABLE}").fetchone() == (3,)
    assert dataset.con.execute("SELECT count(*) FROM information_schema.tables").fetchone() == (1,)


def test_values_never_appear_in_compiled_sql_and_identifiers_are_always_quoted() -> None:
    marker = "ZZ_MARKER_ZZ"
    cases = [
        {"type": "in_set", "column": "code", "values": [marker]},
        {"type": "regex", "column": "code", "pattern": marker},
        {"type": "conditional_not_null", "column": "label", "when_column": "code", "when_values": [marker]},
        {"type": "range", "column": "amount", "min": 123456.5, "max": 654321.5},
        {"type": "derived_ratio", "column": "pct", "numerator_column": "amount",
         "denominator_column": "base", "multiplier": 31337, "tolerance": 0.4242},
    ]  # fmt: skip
    for raw in cases:
        compiled = compile_rule(validate_rule(raw, COLUMNS), COLUMNS, AS_OF)
        sql = compiled.evaluated_sql + compiled.violations_sql
        for secret in (marker, "123456.5", "654321.5", "31337", "0.4242"):
            assert secret not in sql
        assert compiled.params
        for name in rule_columns(validate_rule(raw, COLUMNS)):
            assert f'"{name}"' in sql
    as_of = compile_rule({"type": "date_not_future", "column": "opened"}, COLUMNS, AS_OF)
    assert "2025-09-30" not in as_of.violations_sql and as_of.params == {"as_of": "2025-09-30"}


def test_the_compiler_does_not_trust_its_caller() -> None:
    # A rule that skipped validation still cannot name a column that is not in the dataset.
    with pytest.raises(RuleError, match="Unknown column"):
        compile_rule({"type": "not_null", "column": "1; DROP TABLE dataset; --"}, COLUMNS, AS_OF)
    with pytest.raises(RuleError, match="Unknown column"):
        compile_rule({"type": "unique", "columns": ["id", "nope"]}, COLUMNS, AS_OF)
    with pytest.raises(RuleError, match="Unknown rule type"):
        compile_rule({"type": "raw_sql"}, COLUMNS, AS_OF)


def test_a_bad_rule_becomes_an_error_result_and_the_rest_still_run() -> None:
    results = run_rules(
        table(),
        [
            {"type": "not_null", "column": "nope"},
            "SELECT * FROM dataset",
            {"type": "not_null", "column": "id"},
        ],
        as_of=AS_OF,
    )
    assert [r.status for r in results] == ["error", "error", "fail"]
    assert results[0].error == "Unknown column 'nope' in 'column'."
    assert results[0].sql is None and results[1].rule == {"type": "invalid"}
    with pytest.raises(RuleError, match="At most"):
        run_rules(table(), [{"type": "not_null", "column": "id"}] * 301, as_of=AS_OF)


def test_a_rejected_rule_is_echoed_back_bounded_and_json_safe() -> None:
    # json.loads reads Infinity, NaN, and 1e400 as non-finite floats; json.dumps in strict
    # mode refuses to write them. The rule must be rejected without breaking the response.
    import json

    raw = json.loads('{"type": "range", "column": "amount", "min": 1e400, "max": NaN}')
    result = run_rule(table(), raw, as_of=AS_OF)
    assert (result.status, result.error) == ("error", "'min' must be a finite number.")
    assert result.rule == {"type": "range", "column": "amount", "min": "inf", "max": "nan"}
    json.dumps(result.model_dump(), allow_nan=False)

    huge = {"type": "in_set", "column": "nope", "values": ["v" * 5000] * 5000, "x": {"a": {"b": {"c": {"d": 1}}}}}  # fmt: skip
    echoed = echo_safe(huge)
    assert len(echoed["values"]) == 50 and len(echoed["values"][0]) == 300
    assert echoed["x"] == {"a": {"b": {"c": "…"}}}
    assert echo_safe({"when": date(2024, 1, 1)}) == {"when": "2024-01-01"}


# ----------------------------------------------------------------- engine answers


@pytest.mark.parametrize(
    ("raw", "evaluated", "rows"),
    [
        ({"type": "not_null", "column": "id"}, 6, [6]),
        ({"type": "unique", "columns": ["id"]}, 5, [3, 4]),
        ({"type": "unique", "columns": ["id", "label"]}, 5, []),
        ({"type": "in_set", "column": "code", "values": ["P", "S"]}, 5, [5]),
        ({"type": "range", "column": "amount", "min": 0, "max": 500}, 4, [3, 5]),
        ({"type": "range", "column": "amount", "min": None, "max": 100}, 4, [2, 5]),
        ({"type": "regex", "column": "id", "pattern": "A[0-9]"}, 5, []),
        ({"type": "regex", "column": "label", "pattern": "[A-Z][a-z]{5,}"}, 5, [5]),
        ({"type": "parses_as", "column": "amount", "as_type": "integer"}, 5, [4]),
        ({"type": "parses_as", "column": "pct", "as_type": "integer"}, 5, [1, 2, 3, 4, 5]),
        ({"type": "parses_as", "column": "pct", "as_type": "decimal"}, 5, []),
        ({"type": "parses_as", "column": "opened", "as_type": "date"}, 5, [5]),
        ({"type": "date_not_future", "column": "opened"}, 4, [3]),
        (
            {"type": "date_order", "before_column": "opened", "after_column": "closed", "allow_equal": False},
            4,
            [2, 4],
        ),
        (
            {"type": "date_order", "before_column": "opened", "after_column": "closed", "allow_equal": True},
            4,
            [4],
        ),
        (
            {"type": "conditional_not_null", "column": "amount", "when_column": "code", "when_values": ["P", "S"]},
            4,
            [],
        ),
        (
            {"type": "conditional_not_null", "column": "id", "when_column": "label", "when_values": ["Other", "None"]},
            1,
            [],
        ),
        ({"type": "reference_consistency", "key_column": "code", "dependent_column": "label"}, 5, [3]),
        (
            {"type": "derived_ratio", "column": "pct", "numerator_column": "amount",
             "denominator_column": "base", "multiplier": 100, "tolerance": 0.01},
            4,
            [5],
        ),
    ],
)  # fmt: skip
def test_each_rule_type_on_a_table_with_known_answers(
    raw: dict[str, Any], evaluated: int, rows: list[int]
) -> None:
    dataset = table()
    result = run_rule(dataset, raw, as_of=AS_OF)
    assert result.error is None
    assert (result.evaluated, result.failed, result.passed) == (
        evaluated,
        len(rows),
        evaluated - len(rows),
    )
    assert result.status == ("fail" if rows else "pass")
    assert failing_rows(dataset, raw, AS_OF) == rows
    assert [s.row for s in result.samples] == sorted(rows)[:5] or raw["type"] in (
        "unique",
        "reference_consistency",
    )


def test_reference_consistency_ties_resolve_to_the_smallest_value() -> None:
    dataset = make_dataset(["k", "v"], [("a", "y"), ("a", "x"), ("b", "z"), ("b", "z")])
    assert failing_rows(dataset, {"type": "reference_consistency", "key_column": "k", "dependent_column": "v"}, AS_OF) == [1]  # fmt: skip


def test_samples_show_context_columns_and_group_duplicates_together() -> None:
    result = run_rule(
        table(), {"type": "unique", "columns": ["id"]}, as_of=AS_OF, context_columns=["label", "id"]
    )
    assert result.sample_columns == ["label", "id"]
    assert [(s.row, s.values) for s in result.samples] == [
        (3, {"label": "Second", "id": "A3"}),
        (4, {"label": "Primary", "id": "A3"}),
    ]
    assert result.sql is not None and 'PARTITION BY "id"' in result.sql
    assert result.pass_rate == pytest.approx(3 / 5)


# ----------------------------------------------------------------- planted issues


def test_engine_finds_exactly_the_rows_the_generator_planted(
    sample: Dataset, manifest: dict[str, Any], as_of: date
) -> None:
    assert len(manifest["issues"]) == 17
    for issue in manifest["issues"]:
        assert failing_rows(sample, issue["rule"], as_of) == issue["rows"], issue["id"]
        result = run_rule(sample, issue["rule"], as_of=as_of, context_columns=["loan_id"])
        assert result.status == "fail" and result.failed == issue["count"], issue["id"]
        assert result.sample_columns[0] == "loan_id"
        assert {s.row for s in result.samples} <= set(issue["rows"])


def test_clean_columns_pass(sample: Dataset, as_of: date) -> None:
    for raw in (
        {"type": "not_null", "column": "loan_id"},
        {"type": "regex", "column": "loan_id", "pattern": "LN[0-9]{8}"},
        {"type": "in_set", "column": "mi_type_code", "values": ["NONE", "BPMI", "LPMI"]},
        {"type": "reference_consistency", "key_column": "property_zip", "dependent_column": "property_city"},
        {"type": "date_order", "before_column": "borrower_dob", "after_column": "origination_date", "allow_equal": False},
    ):  # fmt: skip
        result = run_rule(sample, raw, as_of=as_of)
        assert (result.status, result.failed) == ("pass", 0), raw
    assert sample.con.execute(f"SELECT max({ROW}) FROM {TABLE}").fetchone() == (5014,)
