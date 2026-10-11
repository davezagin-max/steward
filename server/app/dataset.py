"""Load a CSV into a private in-memory DuckDB table.

Design:

- Every column is loaded as text. The profiler infers types from parse rates and the
  rules engine casts explicitly, so one unparseable date can never make the load fail or
  silently become NULL: it stays visible as a bad value.
- Headers are untrusted. They are rewritten to plain `[a-z0-9_]` identifiers, and every
  identifier that reaches SQL is still double-quoted (see `quote_ident`).
- The data lives only in a connection created for the request. Once the table is built,
  the connection loses file-system and network access.
"""

from __future__ import annotations

import io
import re
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import duckdb

TABLE = "dataset"
ROW = "__row"  # 1-based data row number; sanitized names can never start with "_"

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_ROWS = 50_000
MAX_COLUMNS = 80
MAX_IDENTIFIER_LENGTH = 48

SAMPLE_NAME = "loans_sample.csv"
SAMPLE_PATH = Path(__file__).resolve().parent.parent / "data" / "loans.csv"
MANIFEST_PATH = SAMPLE_PATH.with_name("planted.json")

# Strict text forms. TRY_CAST alone would also accept ' 12 ', '1e5', 'nan', and '2020-1-5'.
INTEGER_RE = r"-?(0|[1-9][0-9]{0,17})"
NUMBER_RE = r"-?((0|[1-9][0-9]{0,17})(\.[0-9]+)?|\.[0-9]+)"
DATE_RE = r"[0-9]{4}-[0-9]{2}-[0-9]{2}"


class DatasetError(ValueError):
    """The upload cannot be used. The message is safe to show to the user."""


def quote_ident(name: str) -> str:
    """Quote an identifier for DuckDB. Embedded double quotes are doubled, so no name can
    close the quotes and continue as SQL."""
    if "\x00" in name:
        raise DatasetError("Identifiers cannot contain a null byte.")
    return '"' + name.replace('"', '""') + '"'


def number_sql(quoted: str) -> str:
    """SQL for the column as DOUBLE, or NULL when the text is not a plain number."""
    return f"CASE WHEN regexp_full_match({quoted}, '{NUMBER_RE}') THEN TRY_CAST({quoted} AS DOUBLE) END"


def integer_sql(quoted: str) -> str:
    return f"CASE WHEN regexp_full_match({quoted}, '{INTEGER_RE}') THEN TRY_CAST({quoted} AS BIGINT) END"


def date_sql(quoted: str) -> str:
    """SQL for the column as DATE, or NULL unless it is a real ISO calendar date."""
    return f"CASE WHEN regexp_full_match({quoted}, '{DATE_RE}') THEN TRY_CAST({quoted} AS DATE) END"


def sanitize_identifiers(headers: Sequence[str]) -> list[str]:
    """Turn arbitrary headers into unique `[a-z][a-z0-9_]*` names, keeping their order."""
    names: list[str] = []
    seen: set[str] = set()
    for position, header in enumerate(headers, start=1):
        base = re.sub(r"[^a-z0-9]+", "_", str(header).strip().lower()).strip("_")
        if not base:
            base = f"column_{position}"
        elif base[0].isdigit():
            base = f"c_{base}"
        base = base[:MAX_IDENTIFIER_LENGTH].rstrip("_")
        name, suffix = base, 2
        while name in seen:
            name = f"{base}_{suffix}"
            suffix += 1
        seen.add(name)
        names.append(name)
    return names


@dataclass
class Dataset:
    con: duckdb.DuckDBPyConnection
    name: str
    columns: list[str]
    source_names: list[str]
    row_count: int

    def close(self) -> None:
        self.con.close()


def clean_name(name: str) -> str:
    """A display name for the upload. Never used as a path or in SQL."""
    cleaned = re.sub(r"[^A-Za-z0-9._ -]+", "_", name.replace("\\", "/").split("/")[-1]).strip()
    return cleaned[:80] or "upload.csv"


def load_csv(
    data: bytes,
    name: str = "upload.csv",
    *,
    max_bytes: int = MAX_UPLOAD_BYTES,
    max_rows: int = MAX_ROWS,
    max_columns: int = MAX_COLUMNS,
) -> Dataset:
    if len(data) > max_bytes:
        raise DatasetError(f"The file is larger than the {max_bytes // (1024 * 1024)} MB limit.")
    if not data.strip():
        raise DatasetError("The file is empty.")

    con = duckdb.connect(":memory:")
    try:
        con.execute("SET threads = 2")
        con.execute("SET memory_limit = '512MB'")
        try:
            relation = con.read_csv(io.BytesIO(data), header=True, all_varchar=True)
            headers = list(relation.columns)
        except duckdb.Error as error:
            raise DatasetError(_csv_error(error)) from error
        if len(headers) > max_columns:
            raise DatasetError(f"The file has {len(headers)} columns; the limit is {max_columns}.")

        columns = sanitize_identifiers(headers)
        select = ", ".join(
            f"CASE WHEN trim({quote_ident(source)}) = '' THEN NULL ELSE {quote_ident(source)} END"
            f" AS {quote_ident(clean)}"
            for source, clean in zip(headers, columns, strict=True)
        )
        try:
            con.register("upload_raw", relation)
            con.execute(
                f"CREATE TABLE {TABLE} AS "
                f"SELECT row_number() OVER () AS {ROW}, {select} FROM upload_raw"
            )
            con.unregister("upload_raw")
        except duckdb.Error as error:
            raise DatasetError(_csv_error(error)) from error

        row = con.execute(f"SELECT count(*) FROM {TABLE}").fetchone()
        row_count = int(row[0]) if row else 0
        if row_count == 0:
            raise DatasetError("The file has a header but no data rows.")
        if row_count > max_rows:
            raise DatasetError(f"The file has {row_count:,} rows; the limit is {max_rows:,}.")

        # From here on the connection can only see the table it already holds.
        con.execute("SET enable_external_access = false")
        con.execute("SET lock_configuration = true")
    except Exception:
        con.close()
        raise
    return Dataset(con, clean_name(name), columns, [str(h) for h in headers], row_count)


def _csv_error(error: Exception) -> str:
    first_line = str(error).strip().splitlines()[0] if str(error).strip() else ""
    if "unicode" in str(error).lower() or "utf-8" in str(error).lower():
        return "The file is not valid UTF-8 text."
    detail = re.sub(r"\s+", " ", first_line)[:160]
    return f"Could not parse the file as CSV. {detail}".strip()


@lru_cache(maxsize=1)
def sample_bytes() -> bytes:
    return SAMPLE_PATH.read_bytes()


def load_sample() -> Dataset:
    """The bundled synthetic loan tape, in a fresh private connection."""
    return load_csv(sample_bytes(), SAMPLE_NAME)
