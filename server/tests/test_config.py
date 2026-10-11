import pytest

from app.config import HAIKU, OPUS, SONNET, Usage, cost_usd


def test_opus_is_4_in_20_out_per_million() -> None:
    assert cost_usd(OPUS, Usage(1_000_000, 1_000_000)) == pytest.approx(24.0)


def test_cache_writes_and_reads_are_priced_separately() -> None:
    assert cost_usd(OPUS, Usage(0, 0, 1_000_000, 1_000_000)) == pytest.approx(5.2)


def test_batch_is_half_price() -> None:
    assert cost_usd(SONNET, Usage(1_000_000, 1_000_000), batch=True) == pytest.approx(6.0)


def test_haiku_long_prompt_tier() -> None:
    assert cost_usd(HAIKU, Usage(100_000, 0)) == pytest.approx(0.01)
    assert cost_usd(HAIKU, Usage(200_000, 0)) == pytest.approx(0.10)


def test_unknown_model_is_priced_as_opus_not_free() -> None:
    assert cost_usd("some-future-model", Usage(1_000_000, 0)) == pytest.approx(4.0)
