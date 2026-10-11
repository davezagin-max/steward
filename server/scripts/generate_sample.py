"""Generate the bundled sample: a synthetic mortgage loan tape with planted data-quality issues.

    uv run python scripts/generate_sample.py

Everything is fake. Names and addresses come from Faker, SSNs use area numbers 900-999
with group 00 (never issued as an SSN or an ITIN), and emails use the reserved
example.com / example.org / example.net domains.

The generator is seeded, so it always writes the same bytes. Alongside the CSV it writes
`planted.json`: for every planted issue, the rule that should catch it and the exact data
rows that rule must flag. The test suite runs the real rules engine against the CSV and
compares it with this manifest, so the engine is checked against ground truth it did not
produce itself.
"""

from __future__ import annotations

import csv
import io
import json
import math
import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from faker import Faker

SEED = 20261011
BASE_ROWS = 5000
AS_OF = date(2025, 9, 30)
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CSV_NAME = "loans.csv"
MANIFEST_NAME = "planted.json"

COLUMNS = [
    "loan_id",
    "servicer_id",
    "servicer_loan_number",
    "borrower_first_name",
    "borrower_last_name",
    "borrower_ssn",
    "borrower_dob",
    "borrower_email",
    "property_address",
    "property_city",
    "property_state",
    "property_zip",
    "occupancy_code",
    "loan_purpose_code",
    "product_code",
    "product_description",
    "origination_date",
    "first_payment_date",
    "original_upb",
    "appraised_value",
    "ltv",
    "interest_rate",
    "fico_score",
    "mi_type_code",
    "mi_coverage_pct",
]

# state: (full name, weight, zip prefixes, cities). City names are unique across states.
GEOGRAPHY: dict[str, tuple[str, int, list[str], list[str]]] = {
    "UT": (
        "Utah",
        22,
        ["840", "841", "843", "844", "846", "847"],
        ["Salt Lake City", "Provo", "Ogden", "St. George", "Park City", "Logan"],
    ),
    "CA": (
        "California",
        14,
        ["900", "902", "913", "921", "941", "945", "951", "958"],
        ["Los Angeles", "San Diego", "San Jose", "Sacramento", "Fresno", "Oakland", "Irvine"],
    ),
    "AZ": (
        "Arizona",
        9,
        ["850", "852", "853", "856", "857", "860"],
        ["Phoenix", "Tucson", "Mesa", "Scottsdale", "Flagstaff", "Chandler"],
    ),
    "CO": (
        "Colorado",
        9,
        ["800", "802", "803", "805", "809", "810"],
        ["Denver", "Boulder", "Fort Collins", "Colorado Springs", "Aurora", "Lakewood"],
    ),
    "TX": (
        "Texas",
        9,
        ["750", "752", "770", "773", "782", "787"],
        ["Dallas", "Houston", "Austin", "San Antonio", "Plano", "Fort Worth"],
    ),
    "ID": (
        "Idaho",
        7,
        ["832", "833", "836", "837", "838"],
        ["Boise", "Meridian", "Idaho Falls", "Coeur d'Alene", "Twin Falls"],
    ),
    "NV": (
        "Nevada",
        7,
        ["890", "891", "894", "895", "897"],
        ["Las Vegas", "Henderson", "Reno", "Sparks", "Carson City"],
    ),
    "WA": (
        "Washington",
        7,
        ["980", "981", "983", "984", "992"],
        ["Seattle", "Tacoma", "Spokane", "Bellevue", "Vancouver"],
    ),
    "OR": (
        "Oregon",
        5,
        ["970", "972", "973", "974", "977"],
        ["Portland", "Eugene", "Salem", "Bend", "Medford"],
    ),
    "NM": (
        "New Mexico",
        3,
        ["870", "871", "875", "880"],
        ["Albuquerque", "Santa Fe", "Las Cruces", "Roswell"],
    ),
    "MT": ("Montana", 2, ["590", "591", "597", "598"], ["Billings", "Missoula", "Bozeman"]),
    "WY": ("Wyoming", 2, ["820", "826", "829"], ["Cheyenne", "Casper", "Laramie"]),
    "MA": (
        "Massachusetts",
        2,
        ["010", "015", "021", "024"],
        ["Boston", "Worcester", "Springfield", "Cambridge"],
    ),
    "NJ": (
        "New Jersey",
        2,
        ["070", "073", "080", "088"],
        ["Newark", "Jersey City", "Trenton", "Princeton"],
    ),
}

PRODUCTS = [
    ("FRM30", "30-Year Fixed", 60),
    ("FRM15", "15-Year Fixed", 14),
    ("ARM51", "5/1 ARM", 12),
    ("ARM71", "7/1 ARM", 8),
    ("FRM20", "20-Year Fixed", 6),
]
SERVICERS = [
    ("SV01", 24),
    ("SV02", 19),
    ("SV03", 15),
    ("SV04", 12),
    ("SV05", 10),
    ("SV06", 9),
    ("SV07", 7),
    ("SV08", 4),
]
BASE_RATE = {2018: 4.6, 2019: 4.0, 2020: 3.2, 2021: 3.0, 2022: 5.3, 2023: 6.8, 2024: 6.7, 2025: 6.6}
OCCUPANCY_VARIANTS = [("p", 12), ("Primary", 9), ("INV", 8), ("S ", 6), ("X", 5)]


@dataclass
class Sample:
    csv_text: str
    manifest: dict[str, Any]


@dataclass
class _Record:
    uid: int
    values: dict[str, str]
    tags: set[str] = field(default_factory=set)


def _weighted(rng: random.Random, options: list[tuple[Any, int]]) -> Any:
    return rng.choices([o[0] for o in options], weights=[o[1] for o in options], k=1)[0]


def _first_payment(origination: date) -> date:
    month = origination.month + 2
    return date(origination.year + (month - 1) // 12, (month - 1) % 12 + 1, 1)


def _shift_years(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years)
    except ValueError:  # 29 February
        return day.replace(year=day.year + years, day=28)


def build() -> Sample:
    """Build the sample in memory. Same seed, same bytes."""
    rng = random.Random(SEED)
    fake = Faker("en_US")
    fake.seed_instance(SEED)

    # Fixed zip codes per city, unique across the file, so zip -> city -> state holds.
    zips: dict[str, list[str]] = {}
    used_zips: set[str] = set()
    for _state, (_name, _weight, prefixes, cities) in GEOGRAPHY.items():
        for index, city in enumerate(cities):
            codes: list[str] = []
            while len(codes) < 3:
                code = prefixes[index % len(prefixes)] + f"{rng.randint(1, 99):02d}"
                if code not in used_zips:
                    used_zips.add(code)
                    codes.append(code)
            zips[city] = codes

    loan_ids = rng.sample(range(10_000_000, 99_999_999), BASE_ROWS)
    next_servicer_number = {servicer: 100_001 for servicer, _ in SERVICERS}
    state_options = [(state, spec[1]) for state, spec in GEOGRAPHY.items()]
    start = date(2018, 1, 2)
    span_days = (date(2025, 8, 29) - start).days

    records: list[_Record] = []
    truth: list[dict[str, Any]] = []
    for i in range(BASE_ROWS):
        servicer = _weighted(rng, SERVICERS)
        servicer_number = next_servicer_number[servicer]
        next_servicer_number[servicer] += rng.randint(1, 3)

        first = fake.first_name()
        last = fake.last_name()
        origination = start + timedelta(days=rng.randint(0, span_days))
        dob = _shift_years(origination, -rng.randint(23, 72)) - timedelta(days=rng.randint(0, 364))

        state = _weighted(rng, state_options)
        city = rng.choice(GEOGRAPHY[state][3])
        product_code, product_description = rng.choices(
            [(p[0], p[1]) for p in PRODUCTS], weights=[p[2] for p in PRODUCTS], k=1
        )[0]

        upb = int(
            round(min(max(rng.lognormvariate(math.log(330_000), 0.45), 60_000), 1_500_000), -2)
        )
        bucket = rng.random()
        if bucket < 0.20:
            target_ltv = rng.uniform(45, 75)
        elif bucket < 0.55:
            target_ltv = rng.uniform(76, 80)
        elif bucket < 0.70:
            target_ltv = rng.uniform(80.5, 85)
        elif bucket < 0.85:
            target_ltv = rng.uniform(85.5, 90)
        elif bucket < 0.97:
            target_ltv = rng.uniform(90.5, 95)
        else:
            target_ltv = rng.uniform(95.5, 97)
        appraised = int(round(upb / (target_ltv / 100), -3))
        ltv = round(upb / appraised * 100, 2)

        rate = BASE_RATE[origination.year] + rng.gauss(0, 0.35)
        if product_code == "FRM15":
            rate -= 0.6
        elif product_code.startswith("ARM"):
            rate -= 0.4
        rate = min(max(round(rate * 8) / 8, 2.0), 9.5)
        fico = int(min(max(rng.gauss(738, 48), 580), 850))

        if ltv > 80:
            mi_type = "BPMI" if rng.random() < 0.85 else "LPMI"
            coverage = "12" if ltv <= 85 else "25" if ltv <= 90 else "30" if ltv <= 95 else "35"
        else:
            mi_type, coverage = "NONE", ""

        email_domain = rng.choice(["example.com", "example.org", "example.net"])
        values = {
            "loan_id": f"LN{loan_ids[i]}",
            "servicer_id": servicer,
            "servicer_loan_number": str(servicer_number),
            "borrower_first_name": first,
            "borrower_last_name": last,
            "borrower_ssn": f"9{rng.randint(0, 99):02d}-00-{rng.randint(0, 9999):04d}",
            "borrower_dob": dob.isoformat(),
            "borrower_email": f"{first}.{last}{rng.randint(1, 99)}@{email_domain}".lower(),
            "property_address": fake.street_address(),
            "property_city": city,
            "property_state": state,
            "property_zip": rng.choice(zips[city]),
            "occupancy_code": _weighted(rng, [("P", 86), ("I", 9), ("S", 5)]),
            "loan_purpose_code": _weighted(rng, [("P", 55), ("R", 27), ("C", 18)]),
            "product_code": product_code,
            "product_description": product_description,
            "origination_date": origination.isoformat(),
            "first_payment_date": _first_payment(origination).isoformat(),
            "original_upb": str(upb),
            "appraised_value": str(appraised),
            "ltv": f"{ltv:.2f}",
            "interest_rate": f"{rate:.3f}",
            "fico_score": str(fico),
            "mi_type_code": mi_type,
            "mi_coverage_pct": coverage,
        }
        records.append(_Record(uid=i, values=values))
        truth.append({"origination": origination, "has_mi": mi_type != "NONE", "state": state})

    # ---- Plant issues on disjoint rows so every expected count is exact. ----
    pool = list(range(BASE_ROWS))
    rng.shuffle(pool)
    taken: set[int] = set()

    def take(count: int, tag: str, eligible: Any = None) -> list[_Record]:
        chosen: list[_Record] = []
        for index in pool:
            if len(chosen) == count:
                break
            if index in taken or (eligible is not None and not eligible(index)):
                continue
            taken.add(index)
            records[index].tags.add(tag)
            chosen.append(records[index])
        if len(chosen) != count:
            raise RuntimeError(f"Not enough rows to plant {tag}")
        return chosen

    for record in take(23, "mi_coverage_missing", lambda i: truth[i]["has_mi"]):
        record.values["mi_coverage_pct"] = ""

    for record in take(14, "ssn_format"):
        record.values["borrower_ssn"] = record.values["borrower_ssn"].replace("-", "")

    for n, record in enumerate(take(22, "state_variant")):
        state = record.values["property_state"]
        record.values["property_state"] = state.lower() if n < 12 else GEOGRAPHY[state][0]

    variants = [variant for variant, count in OCCUPANCY_VARIANTS for _ in range(count)]
    for record, variant in zip(take(len(variants), "occupancy_variant"), variants, strict=True):
        record.values["occupancy_code"] = variant

    descriptions = {code: description for code, description, _ in PRODUCTS}
    for record in take(9, "product_mismatch"):
        others = [d for code, d in descriptions.items() if code != record.values["product_code"]]
        record.values["product_description"] = rng.choice(others)

    for record in take(7, "origination_null"):
        record.values["origination_date"] = ""

    for record in take(6, "origination_future"):
        origination = _shift_years(truth[record.uid]["origination"], 8)
        record.values["origination_date"] = origination.isoformat()
        record.values["first_payment_date"] = _first_payment(origination).isoformat()

    for n, record in enumerate(take(18, "first_payment_unparseable")):
        good = date.fromisoformat(record.values["first_payment_date"])
        if n < 7:
            bad = good.strftime("%m/%d/%Y")
        elif n < 12:
            bad = f"{good.year}-02-30"
        elif n < 16:
            bad = good.strftime("%Y%m%d")
        else:
            bad = "0000-00-00"
        record.values["first_payment_date"] = bad

    for record in take(15, "first_payment_before_origination"):
        origination = truth[record.uid]["origination"]
        earlier = origination - timedelta(days=rng.randint(40, 400))
        record.values["first_payment_date"] = earlier.replace(day=1).isoformat()

    for record in take(3, "upb_negative"):
        record.values["original_upb"] = "-" + record.values["original_upb"]

    for record in take(4, "upb_extreme"):
        record.values["original_upb"] = str(int(record.values["original_upb"]) * 100)

    for record in take(12, "ltv_mismatch"):
        ltv = float(record.values["ltv"])
        drift = rng.uniform(6, 25) * rng.choice([-1, 1])
        record.values["ltv"] = f"{min(max(ltv + drift, 20.0), 140.0):.2f}"

    for record in take(11, "rate_as_fraction"):
        record.values["interest_rate"] = f"{float(record.values['interest_rate']) / 100:.5f}"

    for record in take(4, "rate_times_ten"):
        record.values["interest_rate"] = f"{float(record.values['interest_rate']) * 10:.3f}"

    for record, bad_score in zip(
        take(9, "fico_out_of_range"), ["0"] * 4 + ["999"] * 3 + ["9999"] * 2, strict=True
    ):
        record.values["fico_score"] = bad_score

    for record in take(60, "zip_null"):
        record.values["property_zip"] = ""

    for record in take(150, "fico_null"):
        record.values["fico_score"] = ""

    # Optional contact field: missing at random, overlapping other issues on purpose.
    for record in records:
        if rng.random() < 0.12:
            record.values["borrower_email"] = ""
            record.tags.add("email_null")

    # Duplicate keys: exact double-loads, and stale versions that disagree on a field.
    clean = [i for i in pool if i not in taken]
    next_uid = BASE_ROWS
    for n, index in enumerate(clean[:14]):
        source = records[index]
        copy = _Record(uid=next_uid, values=dict(source.values), tags={"duplicate_key"})
        next_uid += 1
        source.tags.add("duplicate_key")
        if n >= 8:
            copy.values["interest_rate"] = f"{float(copy.values['interest_rate']) + 0.125:.3f}"
            if copy.values["fico_score"]:
                copy.values["fico_score"] = str(min(int(copy.values["fico_score"]) + 12, 850))
            copy.tags.add("duplicate_conflicting")
        else:
            copy.tags.add("duplicate_exact")
        records.append(copy)

    rng.shuffle(records)

    def rows(*tags: str) -> list[int]:
        """1-based data row numbers (header excluded) carrying any of the tags."""
        return [n for n, record in enumerate(records, start=1) if record.tags & set(tags)]

    valid_states = list(GEOGRAPHY)
    issues = [
        {
            "id": "duplicate_loan_id",
            "kind": "duplicate_keys",
            "columns": ["loan_id"],
            "description": "14 loans appear twice: 8 exact double-loads and 6 stale versions that disagree on rate or FICO.",
            "rule": {"type": "unique", "columns": ["loan_id"]},
            "rows": rows("duplicate_key"),
        },
        {
            "id": "duplicate_servicer_key",
            "kind": "duplicate_keys",
            "columns": ["servicer_id", "servicer_loan_number"],
            "description": "The same 14 duplicated loans also break the composite servicer key.",
            "rule": {"type": "unique", "columns": ["servicer_id", "servicer_loan_number"]},
            "rows": rows("duplicate_key"),
        },
        {
            "id": "origination_date_null",
            "kind": "nulls",
            "columns": ["origination_date"],
            "description": "Origination date is missing on 7 loans.",
            "rule": {"type": "not_null", "column": "origination_date"},
            "rows": rows("origination_null"),
        },
        {
            "id": "property_zip_null",
            "kind": "nulls",
            "columns": ["property_zip"],
            "description": "ZIP code is missing on 60 loans.",
            "rule": {"type": "not_null", "column": "property_zip"},
            "rows": rows("zip_null"),
        },
        {
            "id": "fico_score_null",
            "kind": "nulls",
            "columns": ["fico_score"],
            "description": "FICO score is missing on 150 loans.",
            "rule": {"type": "not_null", "column": "fico_score"},
            "rows": rows("fico_null"),
        },
        {
            "id": "mi_coverage_missing",
            "kind": "nulls",
            "columns": ["mi_coverage_pct", "mi_type_code"],
            "description": "23 insured loans (BPMI or LPMI) have no coverage percentage.",
            "rule": {
                "type": "conditional_not_null",
                "column": "mi_coverage_pct",
                "when_column": "mi_type_code",
                "when_values": ["BPMI", "LPMI"],
            },
            "rows": rows("mi_coverage_missing"),
        },
        {
            "id": "first_payment_unparseable",
            "kind": "bad_dates",
            "columns": ["first_payment_date"],
            "description": "18 first-payment dates are not valid ISO dates (US format, compact format, 30 February, zero date).",
            "rule": {"type": "parses_as", "column": "first_payment_date", "as_type": "date"},
            "rows": rows("first_payment_unparseable"),
        },
        {
            "id": "origination_future",
            "kind": "bad_dates",
            "columns": ["origination_date"],
            "description": "6 loans have an origination date after the as-of date.",
            "rule": {"type": "date_not_future", "column": "origination_date"},
            "rows": rows("origination_future"),
        },
        {
            "id": "first_payment_before_origination",
            "kind": "bad_dates",
            "columns": ["origination_date", "first_payment_date"],
            "description": "15 loans have a first payment dated before origination.",
            "rule": {
                "type": "date_order",
                "before_column": "origination_date",
                "after_column": "first_payment_date",
                "allow_equal": False,
            },
            "rows": rows("first_payment_before_origination"),
        },
        {
            "id": "occupancy_code_variants",
            "kind": "inconsistent_codes",
            "columns": ["occupancy_code"],
            "description": "40 occupancy codes use a variant spelling (p, Primary, INV, a trailing space, X).",
            "rule": {"type": "in_set", "column": "occupancy_code", "values": ["P", "S", "I"]},
            "rows": rows("occupancy_variant"),
        },
        {
            "id": "property_state_variants",
            "kind": "inconsistent_codes",
            "columns": ["property_state"],
            "description": "22 states are lower case or spelled out instead of the two-letter code.",
            "rule": {"type": "in_set", "column": "property_state", "values": valid_states},
            "rows": rows("state_variant"),
        },
        {
            "id": "product_description_mismatch",
            "kind": "inconsistent_codes",
            "columns": ["product_code", "product_description"],
            "description": "9 loans carry a product description that belongs to a different product code.",
            "rule": {
                "type": "reference_consistency",
                "key_column": "product_code",
                "dependent_column": "product_description",
            },
            "rows": rows("product_mismatch"),
        },
        {
            "id": "ssn_format",
            "kind": "format",
            "columns": ["borrower_ssn"],
            "description": "14 SSNs are stored without dashes.",
            "rule": {"type": "regex", "column": "borrower_ssn", "pattern": r"\d{3}-\d{2}-\d{4}"},
            "rows": rows("ssn_format"),
        },
        {
            "id": "interest_rate_scale",
            "kind": "out_of_range",
            "columns": ["interest_rate"],
            "description": "15 rates are on the wrong scale: 11 entered as a fraction, 4 multiplied by ten.",
            "rule": {"type": "range", "column": "interest_rate", "min": 1, "max": 15},
            "rows": rows("rate_as_fraction", "rate_times_ten"),
        },
        {
            "id": "fico_out_of_range",
            "kind": "out_of_range",
            "columns": ["fico_score"],
            "description": "9 FICO scores fall outside 300-850 (0, 999, 9999).",
            "rule": {"type": "range", "column": "fico_score", "min": 300, "max": 850},
            "rows": rows("fico_out_of_range"),
        },
        {
            "id": "original_upb_out_of_range",
            "kind": "out_of_range",
            "columns": ["original_upb"],
            "description": "7 balances are impossible: 3 negative and 4 a hundred times too large.",
            "rule": {"type": "range", "column": "original_upb", "min": 1, "max": 5_000_000},
            "rows": rows("upb_negative", "upb_extreme"),
        },
        {
            "id": "ltv_not_derived",
            "kind": "derived_mismatch",
            "columns": ["ltv", "original_upb", "appraised_value"],
            "description": "19 loans have an LTV that does not equal balance / appraised value: 12 stale LTVs plus the 7 corrupted balances.",
            "rule": {
                "type": "derived_ratio",
                "column": "ltv",
                "numerator_column": "original_upb",
                "denominator_column": "appraised_value",
                "multiplier": 100,
                "tolerance": 0.01,
            },
            "rows": rows("ltv_mismatch", "upb_negative", "upb_extreme"),
        },
    ]
    for issue in issues:
        issue["count"] = len(issue["rows"])

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(COLUMNS)
    for record in records:
        writer.writerow([record.values[column] for column in COLUMNS])

    manifest = {
        "dataset": "loans",
        "file": CSV_NAME,
        "seed": SEED,
        "rows": len(records),
        "columns": COLUMNS,
        "as_of": AS_OF.isoformat(),
        "exact_duplicate_rows": 8,
        "issues": issues,
    }
    return Sample(csv_text=buffer.getvalue(), manifest=manifest)


def main() -> None:
    sample = build()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / CSV_NAME).write_text(sample.csv_text, encoding="utf-8")
    (DATA_DIR / MANIFEST_NAME).write_text(json.dumps(sample.manifest, indent=1) + "\n")
    print(f"wrote {DATA_DIR / CSV_NAME} ({sample.manifest['rows']} rows)")
    for issue in sample.manifest["issues"]:
        print(f"  {issue['id']}: {issue['count']} rows")


if __name__ == "__main__":
    main()
