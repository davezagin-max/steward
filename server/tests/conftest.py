"""Shared fixtures: the bundled sample, its planted-issue manifest, and its profile."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import date
from typing import Any

import duckdb
import pytest

from app.dataset import MANIFEST_PATH, ROW, TABLE, Dataset, load_sample, quote_ident
from app.profiler import Profile, profile_dataset


@pytest.fixture(scope="session")
def manifest() -> dict[str, Any]:
    return json.loads(MANIFEST_PATH.read_text())


@pytest.fixture(scope="session")
def as_of(manifest: dict[str, Any]) -> date:
    return date.fromisoformat(manifest["as_of"])


@pytest.fixture(scope="session")
def sample() -> Iterator[Dataset]:
    dataset = load_sample()
    yield dataset
    dataset.close()


@pytest.fixture(scope="session")
def profile(sample: Dataset, as_of: date) -> Profile:
    return profile_dataset(sample, as_of)


def make_dataset(columns: list[str], rows: list[tuple[str | None, ...]]) -> Dataset:
    """Build a dataset table directly, bypassing header sanitizing.

    Tests use this to give the engine column names an upload could never produce, which
    is the only way to prove the compiler's own quoting holds.
    """
    con = duckdb.connect(":memory:")
    definitions = ", ".join(f"{quote_ident(name)} VARCHAR" for name in columns)
    con.execute(f"CREATE TABLE {TABLE} ({ROW} BIGINT, {definitions})")
    placeholders = ", ".join("?" for _ in range(len(columns) + 1))
    for number, row in enumerate(rows, start=1):
        con.execute(f"INSERT INTO {TABLE} VALUES ({placeholders})", [number, *row])
    return Dataset(con, "test.csv", columns, list(columns), len(rows))
