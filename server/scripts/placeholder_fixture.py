"""Write the hand-written placeholder fixture for the bundled sample.

    uv run python -m scripts.placeholder_fixture

No API key exists yet, so `fixtures/assess.json` cannot hold a recorded run. This script
holds sample tool inputs, written by hand in exactly the shape the two strict tools
return, and passes them through the same normalizer and rule validator the live path
uses. The result is saved with `placeholder: true`, zero usage, and zero cost, and the UI
labels it as sample output.

`scripts/record.py` replaces the fixture with a real run. After either script, run
`scripts/export_demo.py` to rebuild the bundle the Next.js app ships.

Every number quoted in a rationale below is a fact from the deterministic profile.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.assess import (
    COLUMN_EFFORT,
    RELATIONSHIP_EFFORT,
    AssessmentRun,
    PassSummary,
    normalize_column_call,
    normalize_relationships_call,
)
from app.config import OPUS, Usage
from app.dataset import load_sample
from app.main import sample_as_of
from app.profiler import Profile, profile_dataset

FIXTURE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "assess.json"
DEMO_ID = "sample-loans"

STATES = ["UT", "CA", "AZ", "CO", "TX", "ID", "NV", "WA", "OR", "NM", "MT", "WY", "MA", "NJ"]


def rule(severity: str, reason: str, **rule: Any) -> dict[str, Any]:
    return {"rule": rule, "severity": severity, "reason": reason}


def column(
    name: str,
    definition: str,
    sensitivity: str,
    confidence: str,
    rationale: str,
    *rules: dict[str, Any],
) -> dict[str, Any]:
    return {
        "column": name,
        "business_definition": definition,
        "sensitivity": sensitivity,
        "confidence": confidence,
        "rationale": rationale,
        "rules": list(rules),
    }


COLUMN_CALLS: list[dict[str, Any]] = [
    column(
        "loan_id",
        "Identifier the lender assigns to a loan. Each row of this table is meant to describe one loan.",
        "Internal",
        "high",
        "Every value has the shape AA99999999 and 5,000 of 5,014 rows are distinct; the profile lists it as a key candidate with 14 duplicated values. An internal reference number carries no personal information on its own.",
        rule("error", "No nulls today, and a loan cannot be tracked without its identifier.", type="not_null", column="loan_id"),
        rule("error", "99.72% unique with 14 duplicated values: the duplicates are the finding.", type="unique", columns=["loan_id"]),
        rule("warning", "All values match the profiled shape.", type="regex", column="loan_id", pattern="[A-Z]{2}[0-9]{8}"),
    ),
    column(
        "servicer_id",
        "Code for the company that services the loan: it collects payments and manages escrow on the lender's behalf.",
        "Internal",
        "high",
        "Eight codes, SV01 to SV08, with no nulls and one shape. A counterparty code is business data, not personal data.",
        rule("error", "Populated on every row.", type="not_null", column="servicer_id"),
        rule("error", "The profile lists exactly eight codes.", type="in_set", column="servicer_id", values=[f"SV0{n}" for n in range(1, 9)]),
    ),
    column(
        "servicer_loan_number",
        "The servicer's own number for the loan. It identifies a loan within one servicer, not across servicers.",
        "Internal",
        "medium",
        "Six-digit integers with 2,016 distinct values across 5,014 rows, so numbers repeat between servicers; the profile pairs it with servicer_id as a composite key. Confirm with the servicing team that numbering is per servicer.",
        rule("error", "Populated on every row.", type="not_null", column="servicer_loan_number"),
        rule("warning", "All values parse as integers today.", type="parses_as", column="servicer_loan_number", as_type="integer"),
    ),
    column(
        "borrower_first_name",
        "Given name of the primary borrower on the loan.",
        "Confidential",
        "high",
        "The column name and capitalized-word shapes point to a person's first name; values were masked in the profile. A name identifies an individual when combined with the other borrower fields.",
        rule("error", "No nulls today; a borrower record needs a name.", type="not_null", column="borrower_first_name"),
    ),
    column(
        "borrower_last_name",
        "Family name of the primary borrower on the loan.",
        "Confidential",
        "high",
        "Same evidence as the first name: a person-name column with capitalized-word shapes, masked in the profile.",
        rule("error", "No nulls today; a borrower record needs a name.", type="not_null", column="borrower_last_name"),
    ),
    column(
        "borrower_ssn",
        "Social Security number of the primary borrower, used to verify identity and pull credit.",
        "Restricted",
        "high",
        "The name says SSN and 99.72% of values have the dashed shape 999-99-9999. A government identifier is the highest class and should be masked by default.",
        rule("error", "No nulls today.", type="not_null", column="borrower_ssn"),
        rule("error", "0.28% of values are nine digits with no dashes; one storage format prevents failed joins.", type="regex", column="borrower_ssn", pattern="[0-9]{3}-[0-9]{2}-[0-9]{4}"),
    ),
    column(
        "borrower_dob",
        "Date of birth of the primary borrower.",
        "Restricted",
        "high",
        "A date column named dob with every value parsing as a date. Date of birth is a direct identifier and, with a name, is enough to impersonate someone.",
        rule("error", "No nulls today.", type="not_null", column="borrower_dob"),
        rule("error", "100% of values parse as ISO dates.", type="parses_as", column="borrower_dob", as_type="date"),
        rule("error", "A birth date cannot be after the as-of date; none are today.", type="date_not_future", column="borrower_dob"),
    ),
    column(
        "borrower_email",
        "Email address used to contact the borrower. Optional.",
        "Confidential",
        "high",
        "All non-null values match an email pattern and 12.17% of rows are empty, which fits an optional contact field, so no required rule is proposed.",
        rule("warning", "Every non-null value already has this shape.", type="regex", column="borrower_email", pattern="[^@\\s]+@[^@\\s]+\\.[a-z]{2,}"),
        rule("warning", "Reject addresses with consecutive dots.", type="regex", column="borrower_email", pattern="(?!.*\\.\\.)[^@\\s]+@[^@\\s]+"),
    ),
    column(
        "property_address",
        "Street address of the property that secures the loan.",
        "Confidential",
        "high",
        "A free-text address column with 33 distinct shapes, masked in the profile. A home address locates an identifiable person.",
        rule("error", "No nulls today; the collateral must be locatable.", type="not_null", column="property_address"),
    ),
    column(
        "property_city",
        "City where the mortgaged property is located.",
        "Internal",
        "high",
        "69 city names with no nulls; the profile shows that property_zip determines it without exception. A city alone does not identify a person.",
        rule("error", "Populated on every row.", type="not_null", column="property_city"),
    ),
    column(
        "property_state",
        "Two-letter USPS code of the state where the mortgaged property is located.",
        "Internal",
        "high",
        "99.56% of values are two capital letters across 14 states. The rest are lower-case codes and spelled-out names such as 'New Mexico', which will split any group-by on state.",
        rule("error", "Populated on every row.", type="not_null", column="property_state"),
        rule("error", "Only the 14 upper-case codes are valid; lower-case and spelled-out variants fail.", type="in_set", column="property_state", values=STATES),
    ),
    column(
        "property_zip",
        "Five-digit ZIP code of the mortgaged property.",
        "Internal",
        "high",
        "Every non-null value is five digits and the column is kept as text because some codes start with zero. 1.2% of rows are empty.",
        rule("warning", "1.2% of rows have no ZIP; geography-based pricing and reporting need it.", type="not_null", column="property_zip"),
        rule("error", "All non-null values match the five-digit shape.", type="regex", column="property_zip", pattern="[0-9]{5}"),
    ),
    column(
        "occupancy_code",
        "How the borrower will use the property: P for primary residence, S for second home, I for investment property.",
        "Internal",
        "high",
        "P, I, and S cover 4,974 rows. Five other spellings appear on 40 rows (p, Primary, INV, 'S ' with a trailing space, and X); occupancy drives pricing, so the variants matter.",
        rule("error", "Populated on every row.", type="not_null", column="occupancy_code"),
        rule("error", "Three valid codes; the 40 variant spellings should fail until they are mapped.", type="in_set", column="occupancy_code", values=["P", "S", "I"]),
    ),
    column(
        "loan_purpose_code",
        "Why the loan was made: P for purchase, R for rate-and-term refinance, C for cash-out refinance.",
        "Internal",
        "low",
        "Three single-letter codes with no description column. The meanings are inferred from mortgage convention and the 55/27/18 split, so confirm them with the data owner before approving the definition.",
        rule("error", "Populated on every row.", type="not_null", column="loan_purpose_code"),
        rule("error", "The profile lists exactly three codes.", type="in_set", column="loan_purpose_code", values=["P", "R", "C"]),
    ),
    column(
        "product_code",
        "Internal code for the mortgage product: fixed-rate terms (FRM30, FRM20, FRM15) and adjustable-rate products (ARM51, ARM71).",
        "Internal",
        "high",
        "Five codes sharing one shape, each paired with a readable name in product_description.",
        rule("error", "Populated on every row.", type="not_null", column="product_code"),
        rule("error", "The profile lists exactly five codes.", type="in_set", column="product_code", values=["FRM30", "FRM20", "FRM15", "ARM51", "ARM71"]),
    ),
    column(
        "product_description",
        "Customer-facing name of the mortgage product, such as '30-Year Fixed' or '5/1 ARM'.",
        "Public",
        "high",
        "Five product names that a lender prints on rate sheets. It is reference data with nothing specific to a borrower.",
        rule("error", "Populated on every row.", type="not_null", column="product_description"),
        rule("error", "The profile lists exactly five names.", type="in_set", column="product_description", values=["30-Year Fixed", "20-Year Fixed", "15-Year Fixed", "5/1 ARM", "7/1 ARM"]),
    ),
    column(
        "origination_date",
        "Date the loan closed and the funds were disbursed.",
        "Internal",
        "high",
        "A date column running from 2018-01-02, but its maximum is 2033-05-10 and 6 values fall after the as-of date. 0.14% of rows are empty.",
        rule("error", "0.14% of rows have no origination date; loan age and seasoning cannot be computed without it.", type="not_null", column="origination_date"),
        rule("error", "All non-null values parse as ISO dates today.", type="parses_as", column="origination_date", as_type="date"),
        rule("error", "6 values are after the as-of date; a loan cannot originate in the future.", type="date_not_future", column="origination_date"),
    ),
    column(
        "first_payment_date",
        "Due date of the borrower's first scheduled payment, normally the first of the month one to two months after origination.",
        "Internal",
        "high",
        "99.64% of values parse as dates. The 18 that do not include 7 written with slashes, 4 with no separators, and 7 that look like dates but are not real calendar days. Dates after the as-of date are expected here, so no future check is proposed.",
        rule("error", "Populated on every row.", type="not_null", column="first_payment_date"),
        rule("error", "18 values are not valid ISO dates.", type="parses_as", column="first_payment_date", as_type="date"),
    ),
    column(
        "original_upb",
        "Unpaid principal balance at origination, in whole dollars: the original loan amount.",
        "Confidential",
        "high",
        "Median 335,600 with quartiles from 246,425 to 450,900, but the minimum is -255,500 (3 negative values) and the maximum is 25,910,000. A loan amount tied to a named borrower is nonpublic personal financial information.",
        rule("error", "Populated on every row.", type="not_null", column="original_upb"),
        rule("warning", "All values parse as integers today.", type="parses_as", column="original_upb", as_type="integer"),
        rule("error", "A balance must be positive, and the four largest outliers are 12 to 26 million against a 75th percentile of 450,900. The 5,000,000 ceiling is a judgment call to review.", type="range", column="original_upb", min=1, max=5000000),
    ),
    column(
        "appraised_value",
        "Appraised value of the property at origination, in whole dollars.",
        "Confidential",
        "medium",
        "Integers from 100,000 to 2,774,000 with a median of 425,000 and no negatives. The name suggests an appraisal, but it could also be the lower of appraisal and purchase price; confirm which.",
        rule("error", "Populated on every row.", type="not_null", column="appraised_value"),
        rule("error", "A property value must be positive. No upper bound is proposed because high-value homes are legitimate.", type="range", column="appraised_value", min=1, max=None),
    ),
    column(
        "ltv",
        "Loan-to-value ratio at origination, as a percentage: the original loan amount divided by the property value.",
        "Confidential",
        "high",
        "Decimals with a median of 79.44 and quartiles from 76.59 to 87.32, which is the usual clustering around 80%. The range runs from 35.00 to 114.48.",
        rule("error", "Populated on every row.", type="not_null", column="ltv"),
        rule("warning", "Purchase and refinance programs rarely exceed 105% LTV; the maximum today is 114.48.", type="range", column="ltv", min=1, max=105),
    ),
    column(
        "interest_rate",
        "Note rate of the loan at origination, in percent per year.",
        "Confidential",
        "high",
        "Quartiles run from 3.375 to 6.375, but the minimum is 0.03625 and 4 values sit above the upper fence at 33.75 to 63.75. Both look like scale errors: rates stored as fractions, and rates multiplied by ten.",
        rule("error", "Populated on every row.", type="not_null", column="interest_rate"),
        rule("error", "Mortgage note rates fall well inside 1 to 15 percent; values outside are on the wrong scale.", type="range", column="interest_rate", min=1, max=15),
    ),
    column(
        "fico_score",
        "The borrower's FICO credit score at origination.",
        "Confidential",
        "high",
        "Quartiles run from 704 to 770, inside the 300 to 850 range FICO defines, but 9 values sit outside the fences, including 4 zeros and a maximum of 9999. A credit score is consumer report information.",
        rule("warning", "2.99% of rows have no score. Some programs allow that, so monitor rather than block.", type="not_null", column="fico_score"),
        rule("warning", "All non-null values parse as integers today.", type="parses_as", column="fico_score", as_type="integer"),
        rule("error", "FICO scores are defined from 300 to 850; zeros and 999-style values are placeholders, not scores.", type="range", column="fico_score", min=300, max=850),
    ),
    column(
        "mi_type_code",
        "Whether the loan carries mortgage insurance and who pays for it: BPMI is borrower-paid, LPMI is lender-paid, NONE means no insurance.",
        "Internal",
        "high",
        "Three codes with no nulls: NONE on 2,719 rows, BPMI on 1,955, and LPMI on 340.",
        rule("error", "Populated on every row.", type="not_null", column="mi_type_code"),
        rule("error", "The profile lists exactly three codes.", type="in_set", column="mi_type_code", values=["NONE", "BPMI", "LPMI"]),
    ),
    column(
        "mi_coverage_pct",
        "Share of the loan balance the mortgage insurer covers if the loan defaults, as a percentage. Empty when the loan has no mortgage insurance.",
        "Internal",
        "medium",
        "Only four values appear (12, 25, 30, and 35) and 54.69% of rows are empty, which is close to the share of loans coded NONE. Whether empty is correct depends on mi_type_code, so that check belongs to the cross-column pass.",
        rule("warning", "Standard coverage tiers; a value outside them is probably a keying error.", type="in_set", column="mi_coverage_pct", values=["12", "25", "30", "35"]),
    ),
]  # fmt: skip


def relationship(
    kind: str,
    columns: list[str],
    description: str,
    confidence: str,
    rationale: str,
    *rules: dict[str, Any],
) -> dict[str, Any]:
    return {
        "kind": kind,
        "columns": columns,
        "description": description,
        "confidence": confidence,
        "rationale": rationale,
        "rules": list(rules),
    }


RELATIONSHIP_CALL: dict[str, Any] = {
    "relationships": [
        relationship(
            "candidate_key",
            ["loan_id"],
            "loan_id is the primary key of the table: one row per loan.",
            "high",
            "It is 99.72% unique with 14 duplicated values, and the dataset has 8 fully identical rows, so the duplicates are load errors rather than a wider grain. borrower_ssn is also nearly unique, but one borrower can hold several loans, so it is not a key.",
        ),
        relationship(
            "composite_key",
            ["servicer_id", "servicer_loan_number"],
            "A servicer and its loan number together identify one loan. This is the alternate key to use when matching against servicer files.",
            "high",
            "The pair is 99.72% unique. If the two columns were unrelated, about 779 colliding rows would be expected; only 14 are observed, the same count as the loan_id duplicates.",
            rule("error", "Enforces the alternate key; the 14 duplicate rows fail it.", type="unique", columns=["servicer_id", "servicer_loan_number"]),
        ),
        relationship(
            "date_ordering",
            ["origination_date", "first_payment_date"],
            "A loan's first payment falls after its origination date.",
            "high",
            "The ordering holds on 99.70% of the 4,989 rows where both dates parse; 15 rows have a first payment dated before origination.",
            rule("error", "A payment cannot be due before the loan exists.", type="date_order", before_column="origination_date", after_column="first_payment_date", allow_equal=False),
        ),
        relationship(
            "date_ordering",
            ["borrower_dob", "origination_date"],
            "A borrower is born before the loan originates.",
            "high",
            "The ordering holds on all 5,007 rows where both dates are present. It costs nothing to keep as a guard against swapped date fields.",
            rule("warning", "Holds on every row today.", type="date_order", before_column="borrower_dob", after_column="origination_date", allow_equal=False),
        ),
        relationship(
            "code_description_pair",
            ["product_code", "product_description"],
            "product_description is the readable name of product_code: each code has exactly one description.",
            "high",
            "The mapping holds on 99.82% of rows in both directions; 9 rows carry a description that belongs to a different code.",
            rule("error", "A code must always carry the same description; 9 rows disagree with the majority mapping.", type="reference_consistency", key_column="product_code", dependent_column="product_description"),
        ),
        relationship(
            "dependent_field",
            ["property_zip", "property_city", "property_state"],
            "A ZIP code determines the city and the state.",
            "high",
            "ZIP to city holds on all 4,954 rows that have a ZIP. ZIP to state has 22 violations, which matches the lower-case and spelled-out state values found in the column pass.",
            rule("warning", "Holds on every row today.", type="reference_consistency", key_column="property_zip", dependent_column="property_city"),
            rule("error", "22 rows carry a state that disagrees with the ZIP's usual state.", type="reference_consistency", key_column="property_zip", dependent_column="property_state"),
        ),
        relationship(
            "dependent_field",
            ["mi_type_code", "mi_coverage_pct"],
            "An insured loan (BPMI or LPMI) must state its coverage percentage.",
            "high",
            "2,295 rows are coded BPMI or LPMI, but mi_coverage_pct is filled on only 2,272 rows. An insurer cannot price or reserve for a loan with no coverage amount.",
            rule("error", "Coverage is required whenever the loan is insured.", type="conditional_not_null", column="mi_coverage_pct", when_column="mi_type_code", when_values=["BPMI", "LPMI"]),
        ),
        relationship(
            "derived_field",
            ["ltv", "original_upb", "appraised_value"],
            "ltv is derived: original_upb divided by appraised_value, times 100.",
            "medium",
            "The names and the two-decimal percentages suggest the formula, and the engine can confirm it row by row. If it holds, the corrupted balances found in the column pass will also show up here.",
            rule("error", "A stored ratio that disagrees with its inputs means one of the three fields is stale.", type="derived_ratio", column="ltv", numerator_column="original_upb", denominator_column="appraised_value", multiplier=100, tolerance=0.01),
        ),
        relationship(
            "dependent_field",
            ["ltv", "mi_type_code"],
            "Loans above 80% LTV normally carry mortgage insurance.",
            "medium",
            "The median LTV is 79.44 and 45.77% of loans are insured, which is consistent with the 80% convention. No rule type in the catalog expresses a numeric condition on another column, so this is recorded for the contract without a rule.",
        ),
    ]
}  # fmt: skip


def build_run(profile: Profile) -> AssessmentRun:
    """Run the hand-written tool inputs through the real normalizer and validator."""
    assessments = []
    for raw in COLUMN_CALLS:
        assessments.append(normalize_column_call(raw, profile, raw["column"]))
    if [a.column for a in assessments] != profile.column_names():
        raise RuntimeError("The placeholder must assess every column, in order.")
    proposed = {r.id for assessment in assessments for r in assessment.rules}
    relationships, failures = normalize_relationships_call(RELATIONSHIP_CALL, profile, proposed)
    if failures:
        raise RuntimeError(f"Placeholder relationships were rejected: {failures}")
    zero = Usage().as_dict()
    return AssessmentRun(
        assessments=assessments,
        relationships=relationships,
        failures=[],
        passes=[
            PassSummary(
                name="columns",
                effort=COLUMN_EFFORT,
                calls=len(assessments),
                retries=0,
                usage=zero,
                cost_usd=0.0,
            ),
            PassSummary(
                name="relationships",
                effort=RELATIONSHIP_EFFORT,
                calls=1,
                retries=0,
                usage=zero,
                cost_usd=0.0,
            ),
        ],
    )


def build_fixture(run: AssessmentRun) -> dict[str, Any]:
    total = len(run.assessments)
    events: list[dict[str, Any]] = [{"at": 0, "event": {"type": "started", "total": total}}]
    clock = 0
    for done, assessment in enumerate(run.assessments, start=1):
        clock += 900 if done == 1 else 260
        events.append(
            {
                "at": clock,
                "event": {
                    "type": "column",
                    "assessment": assessment.model_dump(),
                    "done": done,
                    "total": total,
                },
            }
        )
    events.append({"at": clock, "event": {"type": "pass", "summary": run.passes[0].model_dump()}})
    clock += 2400
    events.append(
        {
            "at": clock,
            "event": {
                "type": "relationships",
                "relationships": [r.model_dump() for r in run.relationships],
            },
        }
    )
    events.append({"at": clock, "event": {"type": "pass", "summary": run.passes[1].model_dump()}})
    return {
        "label": DEMO_ID,
        "placeholder": True,
        "recordedAt": None,
        "model": OPUS,
        "usage": Usage().as_dict(),
        "costUsd": 0,
        "data": run.model_dump(),
        "events": events,
    }


def main() -> None:
    dataset = load_sample()
    try:
        profile = profile_dataset(dataset, sample_as_of())
    finally:
        dataset.close()
    run = build_run(profile)
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps({DEMO_ID: build_fixture(run)}, indent=1) + "\n")
    rules = sum(len(a.rules) for a in run.assessments) + sum(
        len(r.rules) for r in run.relationships
    )
    rejected = sum(len(a.rejected_rules) for a in run.assessments)
    print(
        f"wrote {FIXTURE_PATH}: {len(run.assessments)} columns, {len(run.relationships)} relationships, {rules} rules, {rejected} rejected by the validator"
    )


if __name__ == "__main__":
    main()
