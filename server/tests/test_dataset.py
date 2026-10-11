import duckdb
import pytest

from app.dataset import (
    ROW,
    TABLE,
    DatasetError,
    clean_name,
    load_csv,
    quote_ident,
    sample_bytes,
    sanitize_identifiers,
)


def test_headers_become_plain_unique_identifiers() -> None:
    headers = [
        "Loan ID",
        "loan-id",
        '"; DROP TABLE dataset; --',
        "",
        "2024 balance",
        "__row",
        "SELECT",
        "naïve café",
        "x" * 200,
    ]
    names = sanitize_identifiers(headers)
    assert names[:8] == [
        "loan_id",
        "loan_id_2",
        "drop_table_dataset",
        "column_4",
        "c_2024_balance",
        "row",
        "select",
        "na_ve_caf",
    ]
    assert len(names[8]) <= 48
    assert len(set(names)) == len(names)
    assert all(name.replace("_", "").isalnum() and name[0].isalpha() for name in names)


def test_quote_ident_doubles_embedded_quotes() -> None:
    assert quote_ident('a"b') == '"a""b"'
    with pytest.raises(DatasetError):
        quote_ident("a\x00b")


def test_load_keeps_text_and_row_order_and_blanks_become_null() -> None:
    data = b'id,"note ""x""",when\n007, padded ,2021-02-30\n8,   ,2020-01-05\n9,"a,b",\n'
    dataset = load_csv(data, "notes.csv")
    assert dataset.columns == ["id", "note_x", "when"]
    assert dataset.source_names == ["id", 'note "x"', "when"]
    rows = dataset.con.execute(f"SELECT * FROM {TABLE} ORDER BY {ROW}").fetchall()
    # Leading zeros, inner padding, and an impossible date all survive as text.
    assert rows == [
        (1, "007", " padded ", "2021-02-30"),
        (2, "8", None, "2020-01-05"),
        (3, "9", "a,b", None),
    ]


def test_row_numbers_follow_file_order_on_the_sample() -> None:
    lines = sample_bytes().decode().splitlines()
    dataset = load_csv(sample_bytes())
    for number in (1, 2, 2500, 5014):
        (loan_id,) = dataset.con.execute(
            f"SELECT loan_id FROM {TABLE} WHERE {ROW} = ?", [number]
        ).fetchone()
        assert lines[number].startswith(loan_id + ",")


def test_limits_and_bad_files_are_rejected_with_safe_messages() -> None:
    with pytest.raises(DatasetError, match="empty"):
        load_csv(b"  \n")
    with pytest.raises(DatasetError, match="no data rows"):
        load_csv(b"a,b\n")
    with pytest.raises(DatasetError, match="larger than"):
        load_csv(b"a\n" + b"1\n" * 600_000, max_bytes=1024 * 1024)
    with pytest.raises(DatasetError, match="rows; the limit"):
        load_csv(b"a\n" + b"1\n" * 11, max_rows=10)
    with pytest.raises(DatasetError, match="columns; the limit"):
        load_csv(b"a,b,c\n1,2,3\n", max_columns=2)
    with pytest.raises(DatasetError, match="UTF-8"):
        load_csv(b"a,b\n\xff\xfe\x00,1\n")


def test_connection_is_cut_off_from_files_after_load() -> None:
    dataset = load_csv(b"a\n1\n")
    with pytest.raises(duckdb.Error):
        dataset.con.execute("SELECT * FROM read_csv('/etc/hosts')").fetchall()
    with pytest.raises(duckdb.Error):
        dataset.con.execute("SET enable_external_access = true")


def test_file_names_are_display_only() -> None:
    assert clean_name("../../etc/passwd") == "passwd"
    assert clean_name("C:\\Users\\me\\loans 2025.csv") == "loans 2025.csv"
    assert clean_name("<script>.csv") == "_script_.csv"
    assert clean_name("") == "upload.csv"
