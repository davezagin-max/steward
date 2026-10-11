"""Profiler tests: exact facts on the bundled sample, plus small hand-built tables."""

from __future__ import annotations

import json
import random
from datetime import date

import pytest

from app.dataset import TABLE, Dataset, load_csv, quote_ident, sample_bytes
from app.profiler import (
    FENCE_K,
    Profile,
    column_model_view,
    model_view,
    profile_dataset,
    sensitive_hint,
    shape_sql,
    shape_to_regex,
)
from tests.conftest import make_dataset

AS_OF = date(2025, 9, 30)


def column(profile: Profile, name: str):  # type: ignore[no-untyped-def]
    return next(c for c in profile.columns if c.name == name)


def csv_dataset(text: str) -> Dataset:
    return load_csv(text.encode(), "small.csv")


# ----------------------------------------------------------------- types and basic stats


def test_types_are_inferred_from_parse_rates(profile: Profile) -> None:
    types = {c.name: c.inferred_type for c in profile.columns}
    assert types["loan_id"] == "string"
    assert types["servicer_loan_number"] == "integer"
    assert types["original_upb"] == "integer"
    assert types["ltv"] == "decimal"
    assert types["interest_rate"] == "decimal"
    assert types["borrower_dob"] == "date"
    assert types["origination_date"] == "date"
    # 18 unparseable values do not stop the column from being recognized as a date.
    first_payment = column(profile, "first_payment_date")
    assert first_payment.inferred_type == "date"
    assert first_payment.invalid_count == 18
    assert first_payment.type_conformance == pytest.approx(1 - 18 / 5014, abs=1e-6)
    assert {s.shape: s.count for s in first_payment.invalid_shapes} == {
        "99/99/9999": 7,
        "9999-99-99": 7,  # 30 February and the zero date look like dates but are not
        "99999999": 4,
    }


def test_digit_codes_with_leading_zeros_stay_text(profile: Profile) -> None:
    zip_code = column(profile, "property_zip")
    assert zip_code.inferred_type == "string"
    assert zip_code.role == "category"
    assert [p.name for p in zip_code.named_patterns] == ["us_zip"]
    assert zip_code.numeric is None and zip_code.outliers is None


def test_null_and_distinct_counts(profile: Profile, manifest: dict) -> None:  # type: ignore[type-arg]
    assert profile.row_count == manifest["rows"] == 5014
    assert profile.column_count == 25
    assert profile.duplicate_rows == manifest["exact_duplicate_rows"] == 8
    assert column(profile, "fico_score").null_count == 150
    assert column(profile, "property_zip").null_count == 60
    assert column(profile, "origination_date").null_count == 7
    assert column(profile, "mi_coverage_pct").null_pct == pytest.approx(0.5469, abs=1e-4)
    assert column(profile, "loan_id").distinct_count == 5000
    occupancy = column(profile, "occupancy_code")
    assert occupancy.distinct_count == 8
    assert occupancy.whitespace_count == 6  # the planted "S " with a trailing space
    assert {v.value: v.count for v in occupancy.top_values}["Primary"] == 9


def test_ranges_and_quartiles_on_a_known_column() -> None:
    values = "\n".join(str(n) for n in range(1, 102))  # 1..101
    profile = profile_dataset(csv_dataset(f"n\n{values}\n"), AS_OF)
    stats = profile.columns[0].numeric
    assert stats is not None
    assert (stats.min, stats.max, stats.median, stats.p25, stats.p75) == (1, 101, 51, 26, 76)
    assert stats.mean == 51 and stats.zeros == 0 and stats.negatives == 0


def test_empty_constant_and_all_null_columns_do_not_break() -> None:
    profile = profile_dataset(csv_dataset("a,b,c\nx,,1\nx,,1\nx,,1\n"), AS_OF)
    a, b, c = profile.columns
    assert (a.distinct_count, a.role) == (1, "category")
    assert (b.null_pct, b.inferred_type, b.length, b.shapes) == (1.0, "string", None, [])
    assert c.inferred_type == "integer" and c.outliers is None
    assert c.histogram is not None and [bin.count for bin in c.histogram.bins] == [3]


# ----------------------------------------------------------------- shapes and patterns


@pytest.mark.parametrize(
    ("shape", "regex"),
    [
        ("999-99-9999", "[0-9]{3}-[0-9]{2}-[0-9]{4}"),
        ("AA99999999", "[A-Z]{2}[0-9]{8}"),
        ("Aa+", "[A-Z][a-z]{3,}"),
        ("A+99", "[A-Z]{3,}[0-9]{2}"),
        ("a+.a+99@a+.a+", r"[a-z]{3,}\.[a-z]{3,}[0-9]{2}@[a-z]{3,}\.[a-z]{3,}"),
        (r"A\+", r"[A-Z]\+"),
        ("9/9 A+", "[0-9]/[0-9] [A-Z]{3,}"),
        ("(999) 999-9999", r"\([0-9]{3}\) [0-9]{3}-[0-9]{4}"),
    ],
)
def test_shape_to_regex(shape: str, regex: str) -> None:
    assert shape_to_regex(shape) == regex


def test_shape_sql_escapes_literal_plus_so_run_markers_stay_unambiguous() -> None:
    dataset = make_dataset(["v"], [("C+",), ("ABCD",), ("a\\b",), ("Ab12",)])
    shapes = dataset.con.execute(
        f"SELECT {shape_sql(quote_ident('v'))} FROM {TABLE} ORDER BY 1"
    ).fetchall()
    assert sorted(s[0] for s in shapes) == sorted(["A\\+", "A+", "a\\\\a", "Aa99"])


def test_each_shape_regex_matches_exactly_the_values_with_that_shape(
    sample: Dataset, profile: Profile
) -> None:
    for col in profile.columns:
        q = quote_ident(col.name)
        for shape in col.shapes:
            (by_shape, by_regex, both) = sample.con.execute(
                f"SELECT count(*) FILTER (WHERE {shape_sql(q)} = $shape), "
                f"count(*) FILTER (WHERE regexp_full_match({q}, $regex)), "
                f"count(*) FILTER (WHERE {shape_sql(q)} = $shape AND regexp_full_match({q}, $regex)) "
                f"FROM {TABLE}",
                {"shape": shape.shape, "regex": shape.regex},
            ).fetchone()
            assert by_shape == by_regex == both == shape.count, (col.name, shape.shape)


def test_ssn_pattern_and_sensitive_hints(profile: Profile) -> None:
    ssn = column(profile, "borrower_ssn")
    assert ssn.shapes[0].shape == "999-99-9999" and ssn.shapes[0].count == 5000
    assert ssn.shapes[1].shape == "999999999" and ssn.shapes[1].count == 14
    assert ssn.named_patterns[0].name == "us_ssn"
    flagged = {c.name for c in profile.columns if c.sensitive}
    assert flagged == {
        "borrower_first_name",
        "borrower_last_name",
        "borrower_ssn",
        "borrower_dob",
        "borrower_email",
        "property_address",
    }
    assert sensitive_hint("product_name", []) == []
    assert sensitive_hint("customer_name", []) == ["name looks like a person's name"]


# ----------------------------------------------------------------- outliers


def test_tukey_far_fences_on_a_known_distribution() -> None:
    # Each value three times, so the column reads as a measure rather than an identifier.
    values = [str(n) for n in range(1, 101)] * 3 + ["10000", "-5000"]
    profile = profile_dataset(csv_dataset("n\n" + "\n".join(values) + "\n"), AS_OF)
    col = profile.columns[0]
    assert col.numeric is not None and col.outliers is not None
    iqr = col.numeric.p75 - col.numeric.p25
    assert col.outliers.lower_fence == pytest.approx(col.numeric.p25 - FENCE_K * iqr)
    assert col.outliers.upper_fence == pytest.approx(col.numeric.p75 + FENCE_K * iqr)
    assert (col.outliers.below, col.outliers.above) == (1, 1)
    assert col.outliers.examples == ["10000", "-5000"]
    # The histogram covers the fenced range; the outliers are counted beside it.
    assert col.histogram is not None
    assert sum(b.count for b in col.histogram.bins) == 300
    assert (col.histogram.below, col.histogram.above) == (1, 1)


def test_planted_outliers_are_found_and_a_scale_error_inside_the_fences_is_not(
    profile: Profile,
) -> None:
    fico = column(profile, "fico_score").outliers
    assert fico is not None and (fico.below, fico.above) == (4, 5)
    assert set(fico.examples) == {"0", "999", "9999"}
    rate = column(profile, "interest_rate").outliers
    assert rate is not None
    # Four rates multiplied by ten are far out; the 11 entered as fractions (0.06) sit
    # inside the fences. Outlier detection is a hint, and the range rule is the control.
    assert (rate.below, rate.above) == (0, 4)
    upb = column(profile, "original_upb")
    assert upb.numeric is not None and upb.numeric.negatives == 3
    assert upb.outliers is not None and upb.outliers.examples[0] == "25910000"


# ----------------------------------------------------------------- keys


def test_a_key_with_duplicates_is_still_recognized_as_a_key(profile: Profile) -> None:
    keys = {tuple(k.columns): k for k in profile.candidate_keys}
    loan = keys[("loan_id",)]
    assert not loan.exact
    assert (loan.duplicate_rows, loan.duplicate_groups) == (14, 14)
    assert loan.uniqueness == pytest.approx(5000 / 5014, abs=1e-6)


def test_composite_key_is_found_and_accidental_ones_are_not(profile: Profile) -> None:
    composites = [k for k in profile.candidate_keys if len(k.columns) > 1]
    assert [k.columns for k in composites] == [["servicer_id", "servicer_loan_number"]]
    (servicer,) = composites
    assert servicer.duplicate_rows == 14
    assert servicer.expected_collisions is not None and servicer.expected_collisions > 500


def test_composite_key_needs_surprising_uniqueness() -> None:
    rng = random.Random(7)
    lines = ["order_id,line_no,noise_a,noise_b"]
    noise = rng.sample(range(10_000, 99_999), 4000)
    for index in range(2000):
        # (order_id, line_no) is a real key: 500 orders x 4 lines, every pair used once.
        # (noise_a, noise_b) is unique too, but only because both are near-unique.
        lines.append(
            f"{index // 4 + 1},{index % 4 + 1},{noise[index] // 3},{noise[2000 + index] // 3}"
        )
    profile = profile_dataset(csv_dataset("\n".join(lines) + "\n"), AS_OF)
    composites = [k for k in profile.candidate_keys if len(k.columns) > 1]
    assert [k.columns for k in composites] == [["order_id", "line_no"]]
    assert composites[0].exact and composites[0].expected_collisions == pytest.approx(999.5)


def test_exact_keys_on_small_tables_and_no_composite_guesses() -> None:
    profile = profile_dataset(csv_dataset("id,kind,size\n1,a,S\n2,a,M\n3,b,S\n4,b,M\n"), AS_OF)
    assert [(k.columns, k.exact) for k in profile.candidate_keys] == [(["id"], True)]


# ----------------------------------------------------------------- dependencies and dates


def test_functional_dependencies_with_violation_counts(profile: Profile) -> None:
    found = {(f.determinant, f.dependent): f.violations for f in profile.functional_dependencies}
    assert found == {
        ("property_zip", "property_city"): 0,
        ("property_zip", "property_state"): 22,
        ("property_city", "property_state"): 22,
        ("product_code", "product_description"): 9,
        ("product_description", "product_code"): 9,
    }


def test_date_orderings(profile: Profile) -> None:
    found = {(d.before, d.after): d.violations for d in profile.date_orderings}
    assert found == {
        ("borrower_dob", "origination_date"): 0,
        ("borrower_dob", "first_payment_date"): 0,
        ("origination_date", "first_payment_date"): 15,
    }
    assert column(profile, "origination_date").dates.future_count == 6  # type: ignore[union-attr]


# ----------------------------------------------------------------- what the model sees


def test_model_view_never_contains_raw_values_from_sensitive_columns(profile: Profile) -> None:
    text = json.dumps(model_view(profile))
    rows = sample_bytes().decode().splitlines()[1:]
    header = sample_bytes().decode().splitlines()[0].split(",")
    import csv
    import io

    parsed = list(csv.DictReader(io.StringIO(sample_bytes().decode())))
    assert len(parsed) == len(rows) and list(parsed[0]) == header
    for row in parsed:
        for name in ("borrower_ssn", "borrower_email", "property_address", "borrower_dob"):
            if row[name]:
                assert row[name] not in text
    for name in ("borrower_first_name", "borrower_last_name", "borrower_ssn", "borrower_dob"):
        view = column_model_view(column(profile, name))
        assert view["values_masked"] is True
        assert "values" not in view and "numeric" not in view
        assert set(view.get("dates", {})) <= {"future_count"}
        assert "examples" not in json.dumps(view)


def test_model_view_lists_code_values_including_the_rare_dirty_ones(profile: Profile) -> None:
    view = column_model_view(column(profile, "occupancy_code"))
    assert view["values_masked"] is False
    assert {"value": "INV", "count": 8} in view["values"]
    assert view["values_with_outer_whitespace"] == 6
    city = column_model_view(column(profile, "property_city"))
    assert city["values_listed"] == 35 and city["distinct_count"] == 69
