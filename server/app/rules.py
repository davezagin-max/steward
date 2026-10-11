"""The rule DSL and the engine that runs it.

A rule is a small JSON object from a closed catalog, for example

    {"type": "range", "column": "fico_score", "min": 300, "max": 850}

The model proposes rules, a reviewer approves or edits them, and this module is the only
thing that turns them into SQL. Nothing a model or a user writes is ever executed as SQL:

1. `validate_rule` checks the object against the catalog. The type must be known, the
   fields must be exactly the fields of that type, every column must exist in the
   dataset, and every parameter must be in bounds. Anything else raises `RuleError`.
2. `compile_rule` turns a validated rule into two fixed SQL templates (rows evaluated,
   rows violating). Column names are checked against the real column list again and
   double-quoted; every value travels as a bound parameter, including regex patterns.
3. `run_rule` executes them on the request's private in-memory table.

Semantics shared by every rule: NULLs are skipped (use `not_null` to require a value),
and comparisons skip values that do not parse as the type they need (use `parses_as` to
require that). Each rule therefore measures one thing and failure counts do not overlap.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

import duckdb
from pydantic import BaseModel

from .dataset import ROW, TABLE, Dataset, date_sql, integer_sql, number_sql, quote_ident

MAX_TEXT = 200
MAX_SET_VALUE = 100
MAX_SET_VALUES = 200
MAX_UNIQUE_COLUMNS = 4
MAX_RULES_PER_RUN = 300
SAMPLE_LIMIT = 5
SAMPLE_VALUE_CHARS = 120
# Bounds on a rejected rule when it is shown back to the reviewer.
ECHO_TEXT = 300
ECHO_KEY = 40
ECHO_ITEMS = 50
ECHO_DEPTH = 4

FieldKind = Literal[
    "column", "columns", "number", "optional_number", "text", "text_list", "boolean", "choice"
]


class RuleError(ValueError):
    """The rule is not valid for this dataset. The message is safe to show to a reviewer."""


@dataclass(frozen=True)
class FieldSpec:
    name: str
    kind: FieldKind
    label: str
    help: str = ""
    choices: tuple[str, ...] = ()


@dataclass(frozen=True)
class RuleType:
    type: str
    label: str
    summary: str
    scope: Literal["column", "cross_column"]
    fields: tuple[FieldSpec, ...]


def _catalog(*types: RuleType) -> dict[str, RuleType]:
    return {rule_type.type: rule_type for rule_type in types}


CATALOG: dict[str, RuleType] = _catalog(
    RuleType(
        "not_null",
        "Required",
        "The column must have a value on every row.",
        "column",
        (FieldSpec("column", "column", "Column"),),
    ),
    RuleType(
        "unique",
        "Unique",
        "No two rows may share the same value (or combination of values).",
        "column",
        (
            FieldSpec(
                "columns", "columns", "Columns", "One column, or several for a composite key."
            ),
        ),
    ),
    RuleType(
        "in_set",
        "Allowed values",
        "Every value must be one of a fixed list. Matching is exact, including case and spaces.",
        "column",
        (
            FieldSpec("column", "column", "Column"),
            FieldSpec("values", "text_list", "Allowed values", "One value per line."),
        ),
    ),
    RuleType(
        "range",
        "Numeric range",
        "Numeric values must fall between a minimum and a maximum (inclusive).",
        "column",
        (
            FieldSpec("column", "column", "Column"),
            FieldSpec("min", "optional_number", "Minimum", "Leave empty for no lower bound."),
            FieldSpec("max", "optional_number", "Maximum", "Leave empty for no upper bound."),
        ),
    ),
    RuleType(
        "regex",
        "Pattern",
        "Every value must match a regular expression in full (RE2 syntax).",
        "column",
        (
            FieldSpec("column", "column", "Column"),
            FieldSpec("pattern", "text", "Pattern", "Matched against the whole value."),
        ),
    ),
    RuleType(
        "parses_as",
        "Parses as type",
        "Every value must be a valid ISO date, integer, or decimal.",
        "column",
        (
            FieldSpec("column", "column", "Column"),
            FieldSpec("as_type", "choice", "Type", choices=("date", "integer", "decimal")),
        ),
    ),
    RuleType(
        "date_not_future",
        "Not in the future",
        "Dates must be on or before the as-of date of the run.",
        "column",
        (FieldSpec("column", "column", "Column"),),
    ),
    RuleType(
        "date_order",
        "Date order",
        "One date must come before another on the same row.",
        "cross_column",
        (
            FieldSpec("before_column", "column", "Earlier date"),
            FieldSpec("after_column", "column", "Later date"),
            FieldSpec("allow_equal", "boolean", "Allow the same day"),
        ),
    ),
    RuleType(
        "conditional_not_null",
        "Required when",
        "The column must have a value whenever another column holds one of the listed values.",
        "cross_column",
        (
            FieldSpec("column", "column", "Required column"),
            FieldSpec("when_column", "column", "When column"),
            FieldSpec("when_values", "text_list", "Has one of", "One value per line."),
        ),
    ),
    RuleType(
        "reference_consistency",
        "Consistent mapping",
        "Each value of the key column must always appear with the same value of the dependent column.",
        "cross_column",
        (
            FieldSpec("key_column", "column", "Key column"),
            FieldSpec("dependent_column", "column", "Dependent column"),
        ),
    ),
    RuleType(
        "derived_ratio",
        "Derived ratio",
        "The column must equal numerator / denominator x multiplier, within a tolerance.",
        "cross_column",
        (
            FieldSpec("column", "column", "Derived column"),
            FieldSpec("numerator_column", "column", "Numerator"),
            FieldSpec("denominator_column", "column", "Denominator"),
            FieldSpec("multiplier", "number", "Multiplier", "Use 100 for a percentage."),
            FieldSpec("tolerance", "number", "Tolerance", "Largest allowed absolute difference."),
        ),
    ),
)

Rule = dict[str, Any]


def catalog_json() -> list[dict[str, Any]]:
    """The catalog as data, so the UI can build its edit forms from the same definition."""
    return [
        {
            "type": rule_type.type,
            "label": rule_type.label,
            "summary": rule_type.summary,
            "scope": rule_type.scope,
            "fields": [
                {
                    "name": spec.name,
                    "kind": spec.kind,
                    "label": spec.label,
                    "help": spec.help,
                    "choices": list(spec.choices),
                }
                for spec in rule_type.fields
            ],
        }
        for rule_type in CATALOG.values()
    ]


def rule_wire_schema(columns: Sequence[str]) -> dict[str, Any]:
    """JSON schema for one rule, used inside the strict tool definitions.

    Column fields are an enum of the dataset's real columns, so the model cannot even
    name a column that does not exist. Limits a strict schema cannot express (list sizes,
    numeric bounds, pattern length) stay in `validate_rule`.
    """
    column: dict[str, Any] = {"type": "string", "enum": list(columns)}
    kinds: dict[str, dict[str, Any]] = {
        "column": column,
        "columns": {"type": "array", "items": column},
        "number": {"type": "number"},
        "optional_number": {"type": ["number", "null"]},
        "text": {"type": "string"},
        "text_list": {"type": "array", "items": {"type": "string"}},
        "boolean": {"type": "boolean"},
    }
    branches = []
    for rule_type in CATALOG.values():
        properties: dict[str, Any] = {"type": {"type": "string", "enum": [rule_type.type]}}
        for spec in rule_type.fields:
            properties[spec.name] = (
                {"type": "string", "enum": list(spec.choices)}
                if spec.kind == "choice"
                else kinds[spec.kind]
            )
        branches.append(
            {
                "type": "object",
                "description": rule_type.summary,
                "properties": properties,
                "required": list(properties),
                "additionalProperties": False,
            }
        )
    return {"anyOf": branches}


# --------------------------------------------------------------------------- validation


def _number(value: Any, name: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise RuleError(f"'{name}' must be a finite number.")
    # 100.0 and 100 are the same rule; keep one spelling so rule ids are stable.
    return int(value) if float(value).is_integer() and abs(value) < 2**53 else float(value)


def _column(value: Any, name: str, columns: Sequence[str]) -> str:
    if not isinstance(value, str):
        raise RuleError(f"'{name}' must be a column name.")
    if value not in columns:
        raise RuleError(f"Unknown column {value[:60]!r} in '{name}'.")
    return value


def _text(value: Any, name: str, limit: int) -> str:
    if not isinstance(value, str) or not value:
        raise RuleError(f"'{name}' must be a non-empty string.")
    if len(value) > limit:
        raise RuleError(f"'{name}' is longer than {limit} characters.")
    if "\x00" in value:
        raise RuleError(f"'{name}' contains a null byte.")
    return value


def _check_regex(pattern: str) -> None:
    con = duckdb.connect(":memory:")
    try:
        con.execute("SELECT regexp_full_match('', $pattern)", {"pattern": pattern}).fetchone()
    except duckdb.Error as error:
        detail = str(error).split(":", 1)[-1].strip()[:80]
        raise RuleError(f"'pattern' is not a valid RE2 regular expression ({detail}).") from error
    finally:
        con.close()


def validate_rule(raw: Any, columns: Sequence[str]) -> Rule:
    """Return the rule in canonical form, or raise `RuleError`."""
    if not isinstance(raw, dict):
        raise RuleError("A rule must be an object.")
    type_name = raw.get("type")
    if not isinstance(type_name, str) or type_name not in CATALOG:
        raise RuleError(f"Unknown rule type {str(type_name)[:40]!r}.")
    rule_type = CATALOG[type_name]
    allowed = {"type"} | {spec.name for spec in rule_type.fields}
    extra = sorted(str(key)[:40] for key in raw if key not in allowed)
    if extra:
        raise RuleError(f"Unexpected field(s) for {type_name}: {', '.join(extra)}.")

    rule: Rule = {"type": type_name}
    for spec in rule_type.fields:
        if spec.name not in raw and spec.kind != "optional_number":
            raise RuleError(f"Missing field '{spec.name}' for {type_name}.")
        value = raw.get(spec.name)
        if spec.kind == "column":
            rule[spec.name] = _column(value, spec.name, columns)
        elif spec.kind == "columns":
            if not isinstance(value, list) or not 1 <= len(value) <= MAX_UNIQUE_COLUMNS:
                raise RuleError(f"'{spec.name}' must list 1 to {MAX_UNIQUE_COLUMNS} columns.")
            names = [_column(item, spec.name, columns) for item in value]
            if len(set(names)) != len(names):
                raise RuleError(f"'{spec.name}' repeats a column.")
            rule[spec.name] = names
        elif spec.kind == "number":
            rule[spec.name] = _number(value, spec.name)
        elif spec.kind == "optional_number":
            rule[spec.name] = None if value is None else _number(value, spec.name)
        elif spec.kind == "text":
            rule[spec.name] = _text(value, spec.name, MAX_TEXT)
        elif spec.kind == "text_list":
            if not isinstance(value, list) or not 1 <= len(value) <= MAX_SET_VALUES:
                raise RuleError(f"'{spec.name}' must list 1 to {MAX_SET_VALUES} values.")
            items = [_text(item, spec.name, MAX_SET_VALUE) for item in value]
            if len(set(items)) != len(items):
                raise RuleError(f"'{spec.name}' repeats a value.")
            rule[spec.name] = items
        elif spec.kind == "boolean":
            if not isinstance(value, bool):
                raise RuleError(f"'{spec.name}' must be true or false.")
            rule[spec.name] = value
        else:
            if value not in spec.choices:
                raise RuleError(f"'{spec.name}' must be one of: {', '.join(spec.choices)}.")
            rule[spec.name] = value

    if type_name == "range":
        low, high = rule["min"], rule["max"]
        if low is None and high is None:
            raise RuleError("A range needs a minimum, a maximum, or both.")
        if low is not None and high is not None and low > high:
            raise RuleError("The minimum is greater than the maximum.")
    elif type_name == "regex":
        _check_regex(rule["pattern"])
    elif type_name == "date_order":
        _distinct(rule, "before_column", "after_column")
    elif type_name == "conditional_not_null":
        _distinct(rule, "column", "when_column")
    elif type_name == "reference_consistency":
        _distinct(rule, "key_column", "dependent_column")
    elif type_name == "derived_ratio":
        _distinct(rule, "column", "numerator_column", "denominator_column")
        if rule["multiplier"] == 0:
            raise RuleError("'multiplier' cannot be zero.")
        if rule["tolerance"] < 0:
            raise RuleError("'tolerance' cannot be negative.")
    return rule


def _distinct(rule: Rule, *fields: str) -> None:
    names = [rule[name] for name in fields]
    if len(set(names)) != len(names):
        raise RuleError(f"{' and '.join(fields)} must be different columns.")


def rule_id(rule: Rule) -> str:
    canonical = json.dumps(rule, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "r_" + hashlib.sha1(canonical.encode(), usedforsecurity=False).hexdigest()[:10]


def rule_columns(rule: Rule) -> list[str]:
    """Columns a validated rule reads, in catalog field order."""
    names: list[str] = []
    for spec in CATALOG[rule["type"]].fields:
        if spec.kind == "column":
            names.append(rule[spec.name])
        elif spec.kind == "columns":
            names.extend(rule[spec.name])
    return list(dict.fromkeys(names))


# --------------------------------------------------------------------------- compiler


@dataclass
class Compiled:
    """Two fixed queries over the dataset table plus their bound parameters."""

    evaluated_sql: str  # SELECT count(*) of the rows the rule applies to
    violations_sql: str  # SELECT __row of the rows that break it
    params: dict[str, Any] = field(default_factory=dict)
    columns: list[str] = field(default_factory=list)
    order_by: list[str] = field(default_factory=list)


def _q(name: Any, columns: Sequence[str]) -> str:
    """Quote a column for SQL. Refuses anything that is not a real column of this dataset,
    even though `validate_rule` already checked: the compiler does not trust its caller."""
    if not isinstance(name, str) or name not in columns:
        raise RuleError(f"Unknown column {str(name)[:60]!r}.")
    return quote_ident(name)


def compile_rule(rule: Rule, columns: Sequence[str], as_of: date) -> Compiled:
    kind = rule.get("type")
    if kind not in CATALOG:
        raise RuleError(f"Unknown rule type {str(kind)[:40]!r}.")
    count = f"SELECT count(*) FROM {TABLE}"
    rows = f"SELECT {ROW} FROM {TABLE}"
    involved = rule_columns(rule)

    if kind == "not_null":
        c = _q(rule["column"], columns)
        return Compiled(count, f"{rows} WHERE {c} IS NULL", columns=involved)

    if kind == "unique":
        quoted = [_q(name, columns) for name in rule["columns"]]
        present = " AND ".join(f"{c} IS NOT NULL" for c in quoted)
        return Compiled(
            f"{count} WHERE {present}",
            f"SELECT {ROW} FROM (SELECT {ROW}, count(*) OVER (PARTITION BY {', '.join(quoted)}) "
            f"AS copies FROM {TABLE} WHERE {present}) WHERE copies > 1",
            columns=involved,
            order_by=quoted,
        )

    if kind == "in_set":
        c = _q(rule["column"], columns)
        return Compiled(
            f"{count} WHERE {c} IS NOT NULL",
            f"{rows} WHERE {c} IS NOT NULL AND NOT list_contains($allowed, {c})",
            {"allowed": list(rule["values"])},
            involved,
        )

    if kind == "range":
        x = number_sql(_q(rule["column"], columns))
        bounds, params = [], {}
        if rule["min"] is not None:
            bounds.append(f"{x} < $low")
            params["low"] = float(rule["min"])
        if rule["max"] is not None:
            bounds.append(f"{x} > $high")
            params["high"] = float(rule["max"])
        return Compiled(
            f"{count} WHERE {x} IS NOT NULL",
            f"{rows} WHERE {x} IS NOT NULL AND ({' OR '.join(bounds)})",
            params,
            involved,
        )

    if kind == "regex":
        c = _q(rule["column"], columns)
        return Compiled(
            f"{count} WHERE {c} IS NOT NULL",
            f"{rows} WHERE {c} IS NOT NULL AND NOT regexp_full_match({c}, $pattern)",
            {"pattern": rule["pattern"]},
            involved,
        )

    if kind == "parses_as":
        c = _q(rule["column"], columns)
        typed = {"date": date_sql, "integer": integer_sql, "decimal": number_sql}[rule["as_type"]](
            c
        )
        return Compiled(
            f"{count} WHERE {c} IS NOT NULL",
            f"{rows} WHERE {c} IS NOT NULL AND {typed} IS NULL",
            columns=involved,
        )

    if kind == "date_not_future":
        d = date_sql(_q(rule["column"], columns))
        return Compiled(
            f"{count} WHERE {d} IS NOT NULL",
            f"{rows} WHERE {d} > CAST($as_of AS DATE)",
            {"as_of": as_of.isoformat()},
            involved,
        )

    if kind == "date_order":
        before = date_sql(_q(rule["before_column"], columns))
        after = date_sql(_q(rule["after_column"], columns))
        both = f"{before} IS NOT NULL AND {after} IS NOT NULL"
        broken = f"{before} > {after}" if rule["allow_equal"] else f"{before} >= {after}"
        return Compiled(
            f"{count} WHERE {both}", f"{rows} WHERE {both} AND {broken}", columns=involved
        )

    if kind == "conditional_not_null":
        c = _q(rule["column"], columns)
        when = _q(rule["when_column"], columns)
        applies = f"{when} IS NOT NULL AND list_contains($when_values, {when})"
        return Compiled(
            f"{count} WHERE {applies}",
            f"{rows} WHERE {applies} AND {c} IS NULL",
            {"when_values": list(rule["when_values"])},
            involved,
        )

    if kind == "reference_consistency":
        key = _q(rule["key_column"], columns)
        dependent = _q(rule["dependent_column"], columns)
        both = f"{key} IS NOT NULL AND {dependent} IS NOT NULL"
        # The most common dependent value per key is the intended mapping (ties go to the
        # smallest value so the result is deterministic); every other row is a violation.
        return Compiled(
            f"{count} WHERE {both}",
            f"WITH pairs AS (SELECT {key} AS k, {dependent} AS d, count(*) AS n FROM {TABLE} "
            f"WHERE {both} GROUP BY {key}, {dependent}), "
            f"ranked AS (SELECT k, d, row_number() OVER (PARTITION BY k ORDER BY n DESC, d) AS pos "
            f"FROM pairs) "
            f"SELECT t.{ROW} FROM {TABLE} AS t JOIN ranked AS r "
            f"ON t.{key} = r.k AND t.{dependent} = r.d WHERE r.pos > 1",
            columns=involved,
            order_by=[key, dependent],
        )

    if kind == "derived_ratio":
        value = number_sql(_q(rule["column"], columns))
        numerator = number_sql(_q(rule["numerator_column"], columns))
        denominator = number_sql(_q(rule["denominator_column"], columns))
        applies = (
            f"{value} IS NOT NULL AND {numerator} IS NOT NULL AND {denominator} IS NOT NULL "
            f"AND {denominator} <> 0"
        )
        return Compiled(
            f"{count} WHERE {applies}",
            f"{rows} WHERE {applies} AND "
            f"abs({value} - {numerator} / {denominator} * $multiplier) > $tolerance + 1e-9",
            {"multiplier": float(rule["multiplier"]), "tolerance": float(rule["tolerance"])},
            involved,
        )

    raise RuleError(f"Unknown rule type {str(kind)[:40]!r}.")


# --------------------------------------------------------------------------- engine


class SampleRow(BaseModel):
    row: int
    values: dict[str, str | None]


class RuleResult(BaseModel):
    rule_id: str
    rule: dict[str, Any]
    status: Literal["pass", "fail", "error"]
    evaluated: int = 0
    failed: int = 0
    passed: int = 0
    pass_rate: float | None = None
    sample_columns: list[str] = []
    samples: list[SampleRow] = []
    sql: str | None = None
    params: dict[str, Any] = {}
    error: str | None = None


def echo_safe(value: Any, depth: int = 0) -> Any:
    """A bounded, JSON-safe copy of something that failed validation, for showing it back.

    A rejected rule can hold anything, including `Infinity` or `NaN` (Python's JSON parser
    accepts both, and reads `1e400` as infinity). Those are not valid JSON on the way out,
    so they are returned as text; long strings, long lists, and deep nesting are cut.
    """
    if value is None or isinstance(value, bool | int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, str):
        return value if len(value) <= ECHO_TEXT else value[: ECHO_TEXT - 1] + "…"
    if depth >= ECHO_DEPTH:
        return "…"
    if isinstance(value, dict):
        return {
            str(key)[:ECHO_KEY]: echo_safe(item, depth + 1)
            for key, item in list(value.items())[:ECHO_ITEMS]
        }
    if isinstance(value, list | tuple):
        return [echo_safe(item, depth + 1) for item in value[:ECHO_ITEMS]]
    return str(value)[:ECHO_TEXT]


def _error_result(raw: Any, message: str) -> RuleResult:
    shown = echo_safe(raw) if isinstance(raw, dict) else {"type": "invalid"}
    digest = hashlib.sha1(repr(raw).encode(), usedforsecurity=False).hexdigest()[:10]
    return RuleResult(rule_id=f"r_{digest}", rule=shown, status="error", error=message)


def failing_rows(dataset: Dataset, raw: Any, as_of: date) -> list[int]:
    """Every row number that breaks the rule. Used by tests and exports."""
    rule = validate_rule(raw, dataset.columns)
    compiled = compile_rule(rule, dataset.columns, as_of)
    found = dataset.con.execute(f"{compiled.violations_sql} ORDER BY 1", compiled.params)
    return [int(row[0]) for row in found.fetchall()]


def run_rule(
    dataset: Dataset,
    raw: Any,
    *,
    as_of: date,
    context_columns: Sequence[str] = (),
    sample_limit: int = SAMPLE_LIMIT,
) -> RuleResult:
    """Validate, compile, and execute one rule. Never raises for a bad rule."""
    try:
        rule = validate_rule(raw, dataset.columns)
        compiled = compile_rule(rule, dataset.columns, as_of)
    except RuleError as error:
        return _error_result(raw, str(error))

    shown = [
        c for c in dict.fromkeys([*context_columns, *compiled.columns]) if c in dataset.columns
    ]
    select = ", ".join(f"t.{quote_ident(name)}" for name in shown)
    order = ", ".join([*(f"t.{c}" for c in compiled.order_by), f"t.{ROW}"])
    try:
        counts = dataset.con.execute(
            f"SELECT ({compiled.evaluated_sql}), (SELECT count(*) FROM ({compiled.violations_sql}))",
            compiled.params,
        ).fetchone()
        evaluated, failed = (int(counts[0]), int(counts[1])) if counts else (0, 0)
        samples = dataset.con.execute(
            f"SELECT t.{ROW}, {select} FROM {TABLE} AS t "
            f"WHERE t.{ROW} IN ({compiled.violations_sql}) ORDER BY {order} LIMIT {int(sample_limit)}",
            compiled.params,
        ).fetchall()
    except duckdb.Error:
        # The message could echo data, so the reviewer gets a fixed one.
        return _error_result(rule, "The engine could not run this rule on this dataset.")

    return RuleResult(
        rule_id=rule_id(rule),
        rule=rule,
        status="fail" if failed else "pass",
        evaluated=evaluated,
        failed=failed,
        passed=evaluated - failed,
        pass_rate=round((evaluated - failed) / evaluated, 6) if evaluated else None,
        sample_columns=shown,
        samples=[
            SampleRow(
                row=int(sample[0]),
                values={
                    name: None if value is None else str(value)[:SAMPLE_VALUE_CHARS]
                    for name, value in zip(shown, sample[1:], strict=True)
                },
            )
            for sample in samples
        ],
        sql=compiled.violations_sql,
        params=compiled.params,
    )


def run_rules(
    dataset: Dataset, rules: Sequence[Any], *, as_of: date, context_columns: Sequence[str] = ()
) -> list[RuleResult]:
    if len(rules) > MAX_RULES_PER_RUN:
        raise RuleError(f"At most {MAX_RULES_PER_RUN} rules can run in one request.")
    return [run_rule(dataset, rule, as_of=as_of, context_columns=context_columns) for rule in rules]
