"""Deterministic profiler. Every number the model or the reviewer sees is computed here.

What it works out, all in DuckDB over text columns:

- **Types** by parse rate: a column is an integer, decimal, or date when at least 95% of
  its non-null values parse as one. The rest are counted as non-conforming and kept
  visible, which is how a handful of bad dates in a date column gets noticed.
- **Shapes**: each value is generalized (letters to `A`/`a`, digits to `9`, long letter
  runs collapsed) and the most common shapes are reported with an equivalent regex.
- **Outliers** by Tukey's far fences (3 x IQR beyond the quartiles). Quartiles do not
  move when a few values are wildly wrong, unlike a mean and standard deviation.
- **Candidate keys**: single columns that are unique or nearly unique (so a key with a
  few duplicate rows is still recognized as a key with a problem), and composite keys
  that are unique *surprisingly* often given how many value combinations exist.
- **Functional dependencies** between categorical columns (code and description pairs,
  zip to state) and **orderings** between date columns, each with a violation count.

`model_view` then produces the masked subset of the profile that is sent to Claude.
"""

from __future__ import annotations

import itertools
import math
from datetime import date
from typing import Any, Literal

import duckdb
from pydantic import BaseModel, Field

from .dataset import ROW, TABLE, Dataset, date_sql, integer_sql, number_sql, quote_ident

TYPE_THRESHOLD = 0.95
CATEGORY_MAX = 60  # distinct values a text column may have and still be a category
NUMERIC_CATEGORY_MAX = 12
CATEGORY_MAX_DISTINCT_PCT = 0.10
IDENTIFIER_MIN_DISTINCT_PCT = 0.90
NEAR_KEY_MIN_UNIQUENESS = 0.995
NEAR_KEY_MAX_NULL_PCT = 0.005
KEY_SURPRISE = 20.0
MAX_KEY_TESTS = 300
MAX_FD_TESTS = 400
FD_MAX_VIOLATION_PCT = 0.02
FENCE_K = 3.0
HISTOGRAM_BINS = 20
TOP_SHAPES = 6

InferredType = Literal["integer", "decimal", "date", "string"]
Role = Literal["identifier", "category", "measure", "date", "text"]

NAMED_PATTERNS: dict[str, str] = {
    "email": r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,}",
    "us_ssn": r"[0-9]{3}-[0-9]{2}-[0-9]{4}",
    "us_phone": r"(\+?1[ .-]?)?\(?[0-9]{3}\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}",
    "us_zip": r"[0-9]{5}(-[0-9]{4})?",
    "uuid": r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
    "ipv4": r"([0-9]{1,3}\.){3}[0-9]{1,3}",
}
SENSITIVE_PATTERNS = {"email", "us_ssn", "us_phone"}
SENSITIVE_TOKENS = {
    "ssn", "social", "tin", "itin", "dob", "birth", "birthdate", "birthday", "email", "phone",
    "mobile", "fax", "address", "addr", "street", "passport", "license", "licence", "account",
    "acct", "iban", "card", "salary", "income", "wage", "password", "secret", "gender", "race",
    "ethnicity", "religion", "diagnosis",
}  # fmt: skip
PERSON_TOKENS = {
    "first", "last", "middle", "full", "sur", "maiden", "given", "family", "borrower", "customer",
    "member", "patient", "employee", "person", "contact", "applicant", "owner", "insured",
}  # fmt: skip


class ValueCount(BaseModel):
    value: str = Field(max_length=400)
    count: int


class ShapeCount(BaseModel):
    shape: str = Field(max_length=400)
    count: int
    pct: float
    regex: str = Field(max_length=1600)


class NamedPattern(BaseModel):
    name: str = Field(max_length=32)
    pct: float


class NumericStats(BaseModel):
    min: float
    max: float
    mean: float
    stddev: float | None
    p25: float
    median: float
    p75: float
    zeros: int
    negatives: int


class DateStats(BaseModel):
    min: str = Field(max_length=10)
    max: str = Field(max_length=10)
    future_count: int


class LengthStats(BaseModel):
    min: int
    max: int


class Outliers(BaseModel):
    method: Literal["tukey_far_fences"] = "tukey_far_fences"
    lower_fence: float
    upper_fence: float
    below: int
    above: int
    examples: list[str] = Field(max_length=6)


class HistogramBin(BaseModel):
    lo: float
    hi: float
    count: int


class Histogram(BaseModel):
    kind: Literal["numeric", "date"]
    bins: list[HistogramBin] = Field(max_length=64)
    below: int
    above: int


class ColumnProfile(BaseModel):
    name: str = Field(max_length=64, pattern=r"^[a-z][a-z0-9_]*$")
    source_name: str = Field(max_length=400)
    position: int
    inferred_type: InferredType
    role: Role
    row_count: int
    null_count: int
    null_pct: float
    distinct_count: int
    distinct_pct: float
    type_conformance: float
    invalid_count: int
    invalid_shapes: list[ShapeCount] = Field(max_length=TOP_SHAPES)
    whitespace_count: int
    length: LengthStats | None
    numeric: NumericStats | None
    dates: DateStats | None
    top_values: list[ValueCount] = Field(max_length=CATEGORY_MAX)
    shapes: list[ShapeCount] = Field(max_length=TOP_SHAPES)
    shape_count: int
    named_patterns: list[NamedPattern] = Field(max_length=len(NAMED_PATTERNS))
    outliers: Outliers | None
    histogram: Histogram | None
    sensitive: bool
    sensitive_reasons: list[str] = Field(max_length=8)


class KeyCandidate(BaseModel):
    columns: list[str] = Field(min_length=1, max_length=4)
    exact: bool
    uniqueness: float
    duplicate_rows: int
    duplicate_groups: int
    # Composite keys only: duplicate rows expected if the columns were independent.
    expected_collisions: float | None


class FunctionalDependency(BaseModel):
    determinant: str = Field(max_length=64)
    dependent: str = Field(max_length=64)
    rows: int
    groups: int
    violations: int
    holds_pct: float


class DateOrdering(BaseModel):
    before: str = Field(max_length=64)
    after: str = Field(max_length=64)
    rows: int
    equal: int
    violations: int
    holds_pct: float


class Profile(BaseModel):
    dataset: str = Field(max_length=80)
    as_of: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    row_count: int
    column_count: int
    duplicate_rows: int
    columns: list[ColumnProfile] = Field(min_length=1, max_length=80)
    candidate_keys: list[KeyCandidate] = Field(max_length=40)
    functional_dependencies: list[FunctionalDependency] = Field(max_length=60)
    date_orderings: list[DateOrdering] = Field(max_length=60)

    def column_names(self) -> list[str]:
        return [column.name for column in self.columns]


# --------------------------------------------------------------------------- shapes


def shape_sql(quoted: str) -> str:
    """SQL that generalizes a value to its shape.

    `LN40718236` becomes `AA99999999`, `Salt Lake City` becomes `A+a+ Aa+ Aa+`... Runs of
    three or more letters of one case collapse to `A+` / `a+`; digits keep their exact
    count because the length of a number usually matters. A literal `+` or `\\` in the data
    is escaped first so the collapsed-run marker stays unambiguous.
    """
    expr = rf"replace(replace({quoted}, '\', '\\'), '+', '\+')"
    for pattern, replacement in (
        ("[A-Z]", "A"),
        ("[a-z]", "a"),
        ("[0-9]", "9"),
        ("A{3,}", "A+"),
        ("a{3,}", "a+"),
    ):
        expr = f"regexp_replace({expr}, '{pattern}', '{replacement}', 'g')"
    return expr


_REGEX_META = set(".^$*+?()[]{}|\\")
_CLASSES = {"A": "[A-Z]", "a": "[a-z]", "9": "[0-9]"}


def shape_to_regex(shape: str) -> str:
    """The regex that matches exactly the values with this shape."""
    out: list[str] = []
    i = 0
    while i < len(shape):
        ch = shape[i]
        if ch == "\\" and i + 1 < len(shape):
            literal = shape[i + 1]
            out.append("\\" + literal if literal in _REGEX_META else literal)
            i += 2
        elif ch in _CLASSES:
            j = i
            while j < len(shape) and shape[j] == ch:
                j += 1
            if ch != "9" and j < len(shape) and shape[j] == "+":
                if j - i > 1:
                    out.append(f"{_CLASSES[ch]}{{{j - i - 1}}}" if j - i > 2 else _CLASSES[ch])
                out.append(_CLASSES[ch] + "{3,}")
                i = j + 1
            else:
                out.append(_CLASSES[ch] + (f"{{{j - i}}}" if j - i > 1 else ""))
                i = j
        else:
            out.append("\\" + ch if ch in _REGEX_META else ch)
            i += 1
    return "".join(out)


# --------------------------------------------------------------------------- helpers


def _row(con: duckdb.DuckDBPyConnection, sql: str, params: Any = None) -> tuple[Any, ...]:
    result = con.execute(sql, params) if params is not None else con.execute(sql)
    row = result.fetchone()
    return tuple(row) if row is not None else ()


def _rows(con: duckdb.DuckDBPyConnection, sql: str, params: Any = None) -> list[tuple[Any, ...]]:
    result = con.execute(sql, params) if params is not None else con.execute(sql)
    return [tuple(row) for row in result.fetchall()]


def _pct(part: float, whole: float) -> float:
    return round(part / whole, 6) if whole else 0.0


def _finite(value: Any) -> float | None:
    if value is None:
        return None
    number = float(value)
    return round(number, 6) if math.isfinite(number) else None


def sensitive_hint(name: str, patterns: list[NamedPattern]) -> list[str]:
    """Conservative, deterministic reasons to treat a column's raw values as sensitive.

    This only decides what is masked before the model sees the profile. The actual
    sensitivity class is the model's suggestion and the reviewer's decision.
    """
    tokens = set(name.split("_"))
    reasons = [f"name contains '{token}'" for token in sorted(tokens & SENSITIVE_TOKENS)]
    if "name" in tokens and tokens & PERSON_TOKENS:
        reasons.append("name looks like a person's name")
    reasons += [
        f"values match {pattern.name}"
        for pattern in patterns
        if pattern.name in SENSITIVE_PATTERNS and pattern.pct >= 0.5
    ]
    return reasons


# --------------------------------------------------------------------------- columns


def _shapes(
    con: duckdb.DuckDBPyConnection, quoted: str, where: str, total: int
) -> tuple[list[ShapeCount], int]:
    rows = _rows(
        con,
        f"SELECT shape, count(*) AS n, count(*) OVER () AS shapes FROM "
        f"(SELECT {shape_sql(quoted)} AS shape FROM {TABLE} WHERE {where}) "
        f"GROUP BY shape ORDER BY n DESC, shape LIMIT {TOP_SHAPES}",
    )
    shapes = [
        ShapeCount(
            shape=str(shape)[:400],
            count=int(n),
            pct=_pct(n, total),
            regex=shape_to_regex(str(shape)[:400]),
        )
        for shape, n, _ in rows
    ]
    return shapes, int(rows[0][2]) if rows else 0


def _histogram(
    con: duckdb.DuckDBPyConnection,
    expr: str,
    lo: float,
    hi: float,
    kind: Literal["numeric", "date"],
) -> Histogram:
    below, above = _row(
        con,
        f"SELECT count(*) FILTER (WHERE x < $lo), count(*) FILTER (WHERE x > $hi) "
        f"FROM (SELECT {expr} AS x FROM {TABLE}) WHERE x IS NOT NULL",
        {"lo": lo, "hi": hi},
    )
    if hi <= lo:
        (count,) = _row(
            con,
            f"SELECT count(*) FROM (SELECT {expr} AS x FROM {TABLE}) WHERE x = $lo",
            {"lo": lo},
        )
        return Histogram(
            kind=kind,
            bins=[HistogramBin(lo=lo, hi=hi, count=int(count))],
            below=int(below),
            above=int(above),
        )
    width = (hi - lo) / HISTOGRAM_BINS
    counts = dict(
        _rows(
            con,
            f"SELECT least(CAST(floor((x - $lo) / $width) AS INTEGER), {HISTOGRAM_BINS - 1}) AS bin, "
            f"count(*) FROM (SELECT {expr} AS x FROM {TABLE}) "
            f"WHERE x IS NOT NULL AND x >= $lo AND x <= $hi GROUP BY bin",
            {"lo": lo, "hi": hi, "width": width},
        )
    )
    bins = [
        HistogramBin(
            lo=round(lo + index * width, 6),
            hi=round(lo + (index + 1) * width, 6),
            count=int(counts.get(index, 0)),
        )
        for index in range(HISTOGRAM_BINS)
    ]
    return Histogram(kind=kind, bins=bins, below=int(below), above=int(above))


def _profile_column(
    con: duckdb.DuckDBPyConnection,
    name: str,
    source_name: str,
    position: int,
    as_of: date,
) -> ColumnProfile:
    q = quote_ident(name)
    num, integer, day = number_sql(q), integer_sql(q), date_sql(q)
    rows, non_null, distinct, n_int, n_num, n_date, n_zero_led, whitespace, len_min, len_max = _row(
        con,
        f"SELECT count(*), count({q}), count(DISTINCT {q}), "
        f"count(*) FILTER (WHERE {integer} IS NOT NULL), "
        f"count(*) FILTER (WHERE {num} IS NOT NULL), "
        f"count(*) FILTER (WHERE {day} IS NOT NULL), "
        f"count(*) FILTER (WHERE regexp_full_match({q}, '0[0-9]+')), "
        f"count(*) FILTER (WHERE {q} <> trim({q})), "
        f"min(length({q})), max(length({q})) FROM {TABLE}",
    )
    inferred: InferredType = "string"
    matching = non_null
    if non_null:
        if n_zero_led and (n_int + n_zero_led) / non_null >= TYPE_THRESHOLD:
            # Digits with leading zeros (ZIP codes, account numbers) are codes, not numbers:
            # reading them as integers would silently drop the zeros.
            pass
        elif n_int / non_null >= TYPE_THRESHOLD:
            inferred, matching = "integer", n_int
        elif n_num / non_null >= TYPE_THRESHOLD:
            inferred, matching = "decimal", n_num
        elif n_date / non_null >= TYPE_THRESHOLD:
            inferred, matching = "date", n_date

    typed = {"integer": integer, "decimal": num, "date": day}.get(inferred)
    shapes, shape_count = _shapes(con, q, f"{q} IS NOT NULL", non_null)
    invalid_count = non_null - matching
    invalid_shapes: list[ShapeCount] = []
    if typed and invalid_count:
        invalid_shapes, _ = _shapes(con, q, f"{q} IS NOT NULL AND {typed} IS NULL", invalid_count)

    patterns: list[NamedPattern] = []
    if non_null and inferred == "string":
        filters = ", ".join(
            f"count(*) FILTER (WHERE regexp_full_match({q}, '{regex}'))"
            for regex in NAMED_PATTERNS.values()
        )
        counts = _row(con, f"SELECT {filters} FROM {TABLE}")
        patterns = [
            NamedPattern(name=pattern, pct=_pct(count, non_null))
            for pattern, count in zip(NAMED_PATTERNS, counts, strict=True)
            if count / non_null >= 0.8
        ]

    distinct_pct = _pct(distinct, non_null)
    top_shape_pct = shapes[0].pct if shapes else 0.0
    role: Role
    if inferred == "date":
        role = "date"
    elif inferred in ("integer", "decimal"):
        if distinct <= NUMERIC_CATEGORY_MAX:
            role = "category"
        elif inferred == "integer" and distinct_pct >= IDENTIFIER_MIN_DISTINCT_PCT:
            role = "identifier"
        else:
            role = "measure"
    elif distinct_pct >= IDENTIFIER_MIN_DISTINCT_PCT and top_shape_pct >= 0.9 and non_null > 1:
        role = "identifier"
    elif distinct <= CATEGORY_MAX or distinct_pct <= CATEGORY_MAX_DISTINCT_PCT:
        role = "category"
    else:
        role = "text"

    numeric: NumericStats | None = None
    outliers: Outliers | None = None
    histogram: Histogram | None = None
    dates: DateStats | None = None

    if inferred in ("integer", "decimal") and matching:
        lo, hi, mean, stddev, quartiles, zeros, negatives = _row(
            con,
            f"SELECT min(x), max(x), avg(x), stddev_samp(x), quantile_cont(x, [0.25, 0.5, 0.75]), "
            f"count(*) FILTER (WHERE x = 0), count(*) FILTER (WHERE x < 0) "
            f"FROM (SELECT {num} AS x FROM {TABLE}) WHERE x IS NOT NULL",
        )
        p25, median, p75 = (round(float(v), 6) for v in quartiles)
        numeric = NumericStats(
            min=float(lo),
            max=float(hi),
            mean=round(float(mean), 6),
            stddev=_finite(stddev),
            p25=p25,
            median=median,
            p75=p75,
            zeros=int(zeros),
            negatives=int(negatives),
        )
        plot_lo, plot_hi = float(lo), float(hi)
        iqr = p75 - p25
        if role == "measure" and iqr > 0:
            lower, upper = p25 - FENCE_K * iqr, p75 + FENCE_K * iqr
            below, above = _row(
                con,
                f"SELECT count(*) FILTER (WHERE x < $lower), count(*) FILTER (WHERE x > $upper) "
                f"FROM (SELECT {num} AS x FROM {TABLE}) WHERE x IS NOT NULL",
                {"lower": lower, "upper": upper},
            )
            examples = _rows(
                con,
                f"SELECT {q} FROM {TABLE} WHERE {num} < $lower OR {num} > $upper "
                f"GROUP BY {q}, {num} ORDER BY abs({num} - $median) DESC, {q} LIMIT 5",
                {"lower": lower, "upper": upper, "median": median},
            )
            outliers = Outliers(
                lower_fence=round(lower, 6),
                upper_fence=round(upper, 6),
                below=int(below),
                above=int(above),
                examples=[str(example[0]) for example in examples],
            )
            plot_lo, plot_hi = max(plot_lo, lower), min(plot_hi, upper)
        if role != "identifier":
            histogram = _histogram(con, num, plot_lo, plot_hi, "numeric")
    elif inferred == "date" and matching:
        epoch = f"date_diff('day', DATE '1970-01-01', {day})"
        lo, hi, first, last, future = _row(
            con,
            f"SELECT min({epoch}), max({epoch}), min({day}), max({day}), "
            f"count(*) FILTER (WHERE {day} > CAST($as_of AS DATE)) FROM {TABLE}",
            {"as_of": as_of.isoformat()},
        )
        dates = DateStats(min=first.isoformat(), max=last.isoformat(), future_count=int(future))
        histogram = _histogram(con, f"CAST({epoch} AS DOUBLE)", float(lo), float(hi), "date")

    top_values: list[ValueCount] = []
    if role == "category":
        top_values = [
            ValueCount(value=str(value)[:400], count=int(count))
            for value, count in _rows(
                con,
                f"SELECT {q}, count(*) AS n FROM {TABLE} WHERE {q} IS NOT NULL "
                f"GROUP BY {q} ORDER BY n DESC, {q} LIMIT {CATEGORY_MAX}",
            )
        ]

    reasons = sensitive_hint(name, patterns)
    return ColumnProfile(
        name=name,
        source_name=source_name[:400],
        position=position,
        inferred_type=inferred,
        role=role,
        row_count=int(rows),
        null_count=int(rows - non_null),
        null_pct=_pct(rows - non_null, rows),
        distinct_count=int(distinct),
        distinct_pct=distinct_pct,
        type_conformance=_pct(matching, non_null) if non_null else 1.0,
        invalid_count=int(invalid_count),
        invalid_shapes=invalid_shapes,
        whitespace_count=int(whitespace),
        length=LengthStats(min=int(len_min), max=int(len_max)) if non_null else None,
        numeric=numeric,
        dates=dates,
        top_values=top_values,
        shapes=shapes,
        shape_count=shape_count,
        named_patterns=patterns,
        outliers=outliers,
        histogram=histogram,
        sensitive=bool(reasons),
        sensitive_reasons=reasons,
    )


# --------------------------------------------------------------------------- relationships


def _distinct_combinations(con: duckdb.DuckDBPyConnection, names: list[str]) -> int:
    columns = ", ".join(quote_ident(name) for name in names)
    (count,) = _row(con, f"SELECT count(*) FROM (SELECT DISTINCT {columns} FROM {TABLE})")
    return int(count)


def candidate_keys(
    con: duckdb.DuckDBPyConnection, columns: list[ColumnProfile], rows: int
) -> list[KeyCandidate]:
    """Single-column keys (exact or nearly unique) and surprising composite keys.

    A composite key is only reported when uniqueness is informative. Two unrelated
    high-cardinality columns are jointly unique by accident, so for each combination we
    compute the duplicate rows expected if the columns were independent (the birthday
    problem: n(n-1) / 2 / product of distinct counts) and require the observed number to
    be at least `KEY_SURPRISE` times smaller. Combinations whose distinct counts cannot
    pass that test are skipped without running a query.
    """
    tolerance = int(rows * (1 - NEAR_KEY_MIN_UNIQUENESS))
    found: list[KeyCandidate] = []
    for column in columns:
        non_null = rows - column.null_count
        extra = non_null - column.distinct_count
        if (
            non_null < 2
            or column.null_count > rows * NEAR_KEY_MAX_NULL_PCT
            or column.role not in ("identifier", "date", "category", "measure")
            or column.inferred_type == "decimal"
            or extra > tolerance
        ):
            continue
        groups = 0
        if extra:
            q = quote_ident(column.name)
            (groups,) = _row(
                con,
                f"SELECT count(*) FROM (SELECT {q} FROM {TABLE} WHERE {q} IS NOT NULL "
                f"GROUP BY {q} HAVING count(*) > 1)",
            )
        found.append(
            KeyCandidate(
                columns=[column.name],
                exact=extra == 0 and column.null_count == 0,
                uniqueness=_pct(column.distinct_count, non_null),
                duplicate_rows=int(extra),
                duplicate_groups=int(groups),
                expected_collisions=None,
            )
        )

    single = {key.columns[0] for key in found}
    eligible = [
        column
        for column in columns
        if column.name not in single
        and column.null_count == 0
        and column.distinct_count >= 2
        and column.inferred_type != "decimal"
        and column.role != "text"
        and not column.sensitive
    ]
    pairs_possible = rows * (rows - 1) / 2
    max_product = pairs_possible / KEY_SURPRISE
    tested = 0
    composites: list[KeyCandidate] = []
    for size in (2, 3):
        combos: list[tuple[int, list[str]]] = []
        for combo in itertools.combinations(eligible, size):
            names = [column.name for column in combo]
            if any(set(key.columns) <= set(names) for key in composites):
                continue
            product = math.prod(column.distinct_count for column in combo)
            if rows - tolerance <= product <= max_product:
                combos.append((product, names))
        for product, names in sorted(combos):
            if tested >= MAX_KEY_TESTS:
                break
            tested += 1
            extra = rows - _distinct_combinations(con, names)
            expected = pairs_possible / product
            if extra <= tolerance and expected >= KEY_SURPRISE * (extra + 1):
                group_columns = ", ".join(quote_ident(name) for name in names)
                (groups,) = _row(
                    con,
                    f"SELECT count(*) FROM (SELECT 1 FROM {TABLE} GROUP BY {group_columns} "
                    f"HAVING count(*) > 1)",
                )
                composites.append(
                    KeyCandidate(
                        columns=names,
                        exact=extra == 0,
                        uniqueness=_pct(rows - extra, rows),
                        duplicate_rows=int(extra),
                        duplicate_groups=int(groups),
                        expected_collisions=round(expected, 1),
                    )
                )
    return found + composites


def functional_dependencies(
    con: duckdb.DuckDBPyConnection, columns: list[ColumnProfile], rows: int
) -> list[FunctionalDependency]:
    """Pairs where one categorical column (almost) determines another.

    For each value of the determinant, the dependent's most common value is taken as the
    intended mapping and every other row counts as a violation. To avoid reporting a
    column that is simply dominated by one value, the mapping must also remove at least
    80% of the errors that "always guess the most common value" would make.
    """
    categories = [c for c in columns if c.role == "category" and c.distinct_count >= 2]
    found: list[FunctionalDependency] = []
    tested = 0
    for determinant in sorted(categories, key=lambda c: -c.distinct_count):
        for dependent in categories:
            if dependent.name == determinant.name:
                continue
            if tested >= MAX_FD_TESTS:
                return found
            tested += 1
            a, b = quote_ident(determinant.name), quote_ident(dependent.name)
            violations, total, groups, top_dependent = _row(
                con,
                f"WITH pairs AS (SELECT {a} AS a, {b} AS b, count(*) AS n FROM {TABLE} "
                f"WHERE {a} IS NOT NULL AND {b} IS NOT NULL GROUP BY {a}, {b}), "
                f"best AS (SELECT a, max(n) AS top, sum(n) AS total FROM pairs GROUP BY a) "
                f"SELECT coalesce(sum(total - top), 0), coalesce(sum(total), 0), count(*), "
                f"(SELECT max(c) FROM (SELECT sum(n) AS c FROM pairs GROUP BY b)) FROM best",
            )
            total, violations, groups = int(total), int(violations), int(groups)
            baseline = total - int(top_dependent or 0)
            if (
                total >= rows * 0.5
                and groups >= 2
                and total / groups >= 3
                and violations <= total * FD_MAX_VIOLATION_PCT
                and baseline > 0
                and violations <= baseline * 0.2
            ):
                found.append(
                    FunctionalDependency(
                        determinant=determinant.name,
                        dependent=dependent.name,
                        rows=total,
                        groups=groups,
                        violations=violations,
                        holds_pct=_pct(total - violations, total),
                    )
                )
    return found


def date_orderings(
    con: duckdb.DuckDBPyConnection, columns: list[ColumnProfile]
) -> list[DateOrdering]:
    """Pairs of date columns where one almost always comes before the other."""
    dated = [column for column in columns if column.inferred_type == "date"]
    found: list[DateOrdering] = []
    for first, second in itertools.permutations(dated, 2):
        a, b = date_sql(quote_ident(first.name)), date_sql(quote_ident(second.name))
        total, earlier, equal = _row(
            con,
            f"SELECT count(*), count(*) FILTER (WHERE a < b), count(*) FILTER (WHERE a = b) "
            f"FROM (SELECT {a} AS a, {b} AS b FROM {TABLE}) WHERE a IS NOT NULL AND b IS NOT NULL",
        )
        if total and (earlier + equal) / total >= 0.98 and earlier / total >= 0.5:
            found.append(
                DateOrdering(
                    before=first.name,
                    after=second.name,
                    rows=int(total),
                    equal=int(equal),
                    violations=int(total - earlier - equal),
                    holds_pct=_pct(earlier + equal, total),
                )
            )
    return found


def profile_dataset(dataset: Dataset, as_of: date | None = None) -> Profile:
    as_of = as_of or date.today()
    con = dataset.con
    columns = [
        _profile_column(con, name, source, position, as_of)
        for position, (name, source) in enumerate(
            zip(dataset.columns, dataset.source_names, strict=True), start=1
        )
    ]
    all_columns = ", ".join(quote_ident(name) for name in dataset.columns)
    (distinct_rows,) = _row(
        con, f"SELECT count(*) FROM (SELECT DISTINCT {all_columns} FROM {TABLE})"
    )
    return Profile(
        dataset=dataset.name,
        as_of=as_of.isoformat(),
        row_count=dataset.row_count,
        column_count=len(columns),
        duplicate_rows=dataset.row_count - int(distinct_rows),
        columns=columns,
        candidate_keys=candidate_keys(con, columns, dataset.row_count),
        functional_dependencies=functional_dependencies(con, columns, dataset.row_count),
        date_orderings=date_orderings(con, columns),
    )


# --------------------------------------------------------------------------- model view

MODEL_VALUE_LIMIT = 35
MODEL_VALUE_CHARS = 40


def _clip(value: str) -> str:
    return value if len(value) <= MODEL_VALUE_CHARS else value[: MODEL_VALUE_CHARS - 1] + "…"


def column_model_view(column: ColumnProfile) -> dict[str, Any]:
    """What Claude is told about one column: aggregates and shapes, never rows.

    Raw values appear only for low-cardinality, non-sensitive columns (codes, flags), where
    the model needs the code list to propose an allowed set. For anything that looks
    sensitive the view keeps counts, lengths, and shapes and drops every raw value,
    including minimum, maximum, and outlier examples.
    """
    view: dict[str, Any] = {
        "name": column.name,
        "type": column.inferred_type,
        "role": column.role,
        "null_pct": round(column.null_pct * 100, 3),
        "distinct_count": column.distinct_count,
        "distinct_pct": round(column.distinct_pct * 100, 3),
        "type_conformance_pct": round(column.type_conformance * 100, 3),
        "values_masked": column.sensitive,
    }
    if column.sensitive:
        view["masked_because"] = column.sensitive_reasons
    if column.invalid_count:
        view["non_conforming"] = {
            "count": column.invalid_count,
            "shapes": [{"shape": s.shape, "count": s.count} for s in column.invalid_shapes],
        }
    if column.whitespace_count:
        view["values_with_outer_whitespace"] = column.whitespace_count
    if column.length:
        view["length"] = {"min": column.length.min, "max": column.length.max}
    if column.inferred_type in ("string", "date") or column.role == "identifier":
        view["shapes"] = [
            {"shape": s.shape, "pct": round(s.pct * 100, 3), "regex": s.regex}
            for s in column.shapes
        ]
        view["distinct_shapes"] = column.shape_count
    if column.named_patterns:
        view["matches"] = [pattern.name for pattern in column.named_patterns]
    if column.sensitive:
        if column.outliers:
            view["outliers"] = {"below": column.outliers.below, "above": column.outliers.above}
        if column.dates:
            view["dates"] = {"future_count": column.dates.future_count}
        return view

    if column.numeric:
        view["numeric"] = column.numeric.model_dump()
    if column.dates:
        view["dates"] = column.dates.model_dump()
    if column.outliers:
        view["outliers"] = column.outliers.model_dump(exclude={"method"})
    if column.role == "category" and column.top_values:
        values = column.top_values
        if len(values) > MODEL_VALUE_LIMIT:
            # Keep the head and the rare tail: rare codes are where the dirty values hide.
            values = values[: MODEL_VALUE_LIMIT - 10] + values[-10:]
        view["values"] = [{"value": _clip(v.value), "count": v.count} for v in values]
        view["values_listed"] = len(values)
    return view


def model_view(profile: Profile) -> dict[str, Any]:
    """The whole dataset profile as Claude sees it."""
    return {
        "dataset": {
            "rows": profile.row_count,
            "columns": profile.column_count,
            "exact_duplicate_rows": profile.duplicate_rows,
            "as_of": profile.as_of,
        },
        "columns": [column_model_view(column) for column in profile.columns],
        "candidate_keys": [key.model_dump() for key in profile.candidate_keys],
        "functional_dependencies": [fd.model_dump() for fd in profile.functional_dependencies],
        "date_orderings": [order.model_dump() for order in profile.date_orderings],
    }


__all__ = [
    "ROW",
    "ColumnProfile",
    "Profile",
    "candidate_keys",
    "column_model_view",
    "date_orderings",
    "functional_dependencies",
    "model_view",
    "profile_dataset",
    "sensitive_hint",
    "shape_sql",
    "shape_to_regex",
]
