"""Tests for Kora SDK sandbox mode."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from kora import Kora


# --- Constructor tests ---

def test_sandbox_no_args():
    """Kora(sandbox=True) works without secret or mandate."""
    kora = Kora(sandbox=True)
    assert kora._sandbox is True


def test_production_requires_secret():
    """Kora() without secret raises ValueError."""
    with pytest.raises(ValueError, match="secret"):
        Kora()


def test_production_requires_mandate():
    """Kora(secret=...) without mandate raises ValueError."""
    with pytest.raises(ValueError, match="mandate"):
        Kora(secret="kora_agent_sk_fake")


# --- spend() approved ---

def test_spend_approved():
    """Basic approved spend returns correct SpendResult."""
    kora = Kora(sandbox=True)
    result = kora.spend("aws", 5000, "EUR")
    assert result.approved is True
    assert result.decision == "APPROVED"
    assert result.reason_code == "OK"
    assert result.payment is not None
    assert result.payment["iban"] == "XX00SANDBOX0000000001"
    assert result.payment["bic"] == "SANDBOXXXX"
    assert result.seal is not None
    assert result.executable is True
    assert result.suggestion is None
    assert result.retry_with is None


def test_spend_decision_id_prefix():
    """Sandbox decision IDs start with sandbox_."""
    kora = Kora(sandbox=True)
    result = kora.spend("aws", 5000, "EUR")
    assert result.decision_id.startswith("sandbox_")


def test_spend_seal_is_sandbox():
    """Sandbox seal has sandbox identifiers."""
    kora = Kora(sandbox=True)
    result = kora.spend("aws", 5000, "EUR")
    assert "sandbox_sig_" in result.seal["signature"]
    assert result.seal["public_key_id"] == "sandbox_key_v1"


def test_spend_tracks_daily():
    """Multiple spends accumulate daily counter."""
    kora = Kora(sandbox=True)
    kora.spend("aws", 500000, "EUR")  # €5,000
    kora.spend("aws", 300000, "EUR")  # €3,000
    budget = kora.check_budget()
    assert budget.daily.spent_cents == 800000
    assert budget.daily.remaining_cents == 200000


def test_spend_all_vendors_same_iban():
    """All vendors return same sandbox IBAN (routing is V2)."""
    kora = Kora(sandbox=True)
    r1 = kora.spend("aws", 1000, "EUR")
    r2 = kora.spend("stripe", 1000, "EUR")
    r3 = kora.spend("random_vendor", 1000, "EUR")
    assert r1.payment["iban"] == r2.payment["iban"] == r3.payment["iban"] == "XX00SANDBOX0000000001"


# --- spend() denied ---

def test_deny_daily_limit():
    """Exceeding daily limit returns DENIED with correct reason."""
    kora = Kora(sandbox=True)
    kora.spend("aws", 900000, "EUR")  # €9,000 — approved
    result = kora.spend("aws", 200000, "EUR")  # €2,000 — exceeds €10k daily
    assert result.approved is False
    assert result.decision == "DENIED"
    assert result.reason_code == "DAILY_LIMIT_EXCEEDED"
    assert result.payment is None
    assert result.seal is None
    assert result.executable is False
    assert result.suggestion is not None
    assert "daily" in result.suggestion.lower() or "reduce" in result.suggestion.lower()


def test_deny_daily_limit_retry_with():
    """DAILY_LIMIT_EXCEEDED includes retry_with with remaining amount."""
    kora = Kora(sandbox=True)
    kora.spend("aws", 900000, "EUR")  # €9,000
    result = kora.spend("aws", 200000, "EUR")  # try €2,000, only €1,000 left
    assert result.retry_with is not None
    assert result.retry_with["amount_cents"] == 100000  # €1,000


def test_deny_monthly_limit():
    """Exceeding monthly limit returns DENIED."""
    kora = Kora(sandbox=True, sandbox_config={"monthly_limit_cents": 100000})
    kora.spend("aws", 80000, "EUR")
    result = kora.spend("aws", 30000, "EUR")
    assert result.reason_code == "MONTHLY_LIMIT_EXCEEDED"


def test_deny_per_tx_limit():
    """Exceeding per-transaction limit returns DENIED."""
    kora = Kora(sandbox=True, sandbox_config={"per_transaction_max_cents": 50000})
    result = kora.spend("aws", 60000, "EUR")
    assert result.reason_code == "PER_TRANSACTION_LIMIT_EXCEEDED"
    assert result.retry_with["amount_cents"] == 50000


def test_deny_vendor_not_allowed():
    """Vendor not in allowlist returns DENIED."""
    kora = Kora(sandbox=True, sandbox_config={"allowed_vendors": ["aws", "gcp"]})
    result = kora.spend("stripe", 5000, "EUR")
    assert result.reason_code == "VENDOR_NOT_ALLOWED"
    assert result.retry_with is None


def test_deny_currency_mismatch():
    """Wrong currency returns DENIED."""
    kora = Kora(sandbox=True)
    result = kora.spend("aws", 5000, "USD")
    assert result.reason_code == "CURRENCY_MISMATCH"


def test_denied_does_not_increment():
    """Denied spend does NOT increment counters."""
    kora = Kora(sandbox=True, sandbox_config={"per_transaction_max_cents": 1000})
    kora.spend("aws", 5000, "EUR")  # denied: per-tx limit
    budget = kora.check_budget()
    assert budget.daily.spent_cents == 0


# --- check_budget() ---

def test_check_budget_initial():
    """Fresh sandbox has full budget available."""
    kora = Kora(sandbox=True)
    budget = kora.check_budget()
    assert budget.currency == "EUR"
    assert budget.status == "active"
    assert budget.spend_allowed is True
    assert budget.daily.limit_cents == 1000000
    assert budget.daily.spent_cents == 0
    assert budget.daily.remaining_cents == 1000000


def test_check_budget_after_spend():
    """Budget reflects spent amounts."""
    kora = Kora(sandbox=True)
    kora.spend("aws", 250000, "EUR")
    budget = kora.check_budget()
    assert budget.daily.spent_cents == 250000
    assert budget.daily.remaining_cents == 750000


def test_check_budget_custom_config():
    """Custom sandbox_config is reflected in budget."""
    kora = Kora(sandbox=True, sandbox_config={
        "daily_limit_cents": 500000,
        "currency": "USD",
        "allowed_vendors": ["aws"],
    })
    budget = kora.check_budget()
    assert budget.daily.limit_cents == 500000
    assert budget.currency == "USD"
    assert budget.allowed_vendors == ["aws"]


# --- Input validation ---

def test_reject_negative_amount():
    """Negative amount_cents raises ValueError."""
    kora = Kora(sandbox=True)
    with pytest.raises(ValueError, match="amount_cents"):
        kora.spend("aws", -100, "EUR")


def test_reject_zero_amount():
    """Zero amount_cents raises ValueError."""
    kora = Kora(sandbox=True)
    with pytest.raises(ValueError, match="amount_cents"):
        kora.spend("aws", 0, "EUR")


def test_reject_float_amount():
    """Float amount_cents raises ValueError."""
    kora = Kora(sandbox=True)
    with pytest.raises(ValueError, match="amount_cents"):
        kora.spend("aws", 50.5, "EUR")


def test_reject_empty_vendor():
    """Empty vendor raises ValueError."""
    kora = Kora(sandbox=True)
    with pytest.raises(ValueError, match="vendor"):
        kora.spend("", 5000, "EUR")


def test_reject_bad_currency():
    """Invalid currency format raises ValueError."""
    kora = Kora(sandbox=True)
    with pytest.raises(ValueError, match="currency"):
        kora.spend("aws", 5000, "EURO")


def test_currency_normalized_uppercase():
    """Lowercase currency is normalized to uppercase."""
    kora = Kora(sandbox=True)
    result = kora.spend("aws", 5000, "eur")
    assert result.approved is True  # should not fail on lowercase


def test_vendor_normalized_lowercase():
    """Uppercase vendor is normalized to lowercase."""
    kora = Kora(sandbox=True)
    result = kora.spend("AWS", 5000, "EUR")
    assert result.approved is True


# --- Environment variable activation ---

def test_env_var_activation(monkeypatch):
    """KORA_SANDBOX=true activates sandbox mode."""
    monkeypatch.setenv("KORA_SANDBOX", "true")
    kora = Kora()  # no secret, no mandate — should not raise
    result = kora.spend("aws", 5000, "EUR")
    assert result.approved is True
    assert result.decision_id.startswith("sandbox_")


def test_env_var_activation_numeric(monkeypatch):
    """KORA_SANDBOX=1 also activates sandbox mode."""
    monkeypatch.setenv("KORA_SANDBOX", "1")
    kora = Kora()
    assert kora._sandbox is True


# --- Stderr warning ---

def test_stderr_warning_once(capsys):
    """Stderr warning emitted exactly once."""
    kora = Kora(sandbox=True)
    kora.spend("aws", 1000, "EUR")
    kora.spend("aws", 1000, "EUR")
    kora.spend("aws", 1000, "EUR")
    captured = capsys.readouterr()
    assert captured.err.count("[KORA SANDBOX]") == 1


# --- sandbox_reset() ---

def test_sandbox_reset():
    """sandbox_reset() clears all counters."""
    kora = Kora(sandbox=True)
    kora.spend("aws", 500000, "EUR")
    kora.sandbox_reset()
    budget = kora.check_budget()
    assert budget.daily.spent_cents == 0
    assert budget.monthly.spent_cents == 0


def test_sandbox_reset_not_in_production():
    """sandbox_reset() raises RuntimeError in production mode."""
    with patch.object(Kora, "__init__", lambda *a, **kw: None):
        kora = Kora.__new__(Kora)
        kora._sandbox = False
        with pytest.raises(RuntimeError, match="sandbox_reset"):
            kora.sandbox_reset()


# --- Self-correcting agent pattern ---

def test_self_correcting_agent_loop():
    """Full agent loop: spend → denied → check budget → retry → approved."""
    kora = Kora(sandbox=True)

    # Spend most of the budget
    r1 = kora.spend("aws", 800000, "EUR")
    assert r1.approved is True

    # Try to overspend
    r2 = kora.spend("aws", 500000, "EUR")
    assert r2.approved is False
    assert r2.retry_with is not None

    # Self-correct with suggested amount
    r3 = kora.spend("aws", r2.retry_with["amount_cents"], "EUR")
    assert r3.approved is True

    # Now fully spent
    r4 = kora.spend("aws", 100, "EUR")
    assert r4.approved is False


# --- raw field ---

def test_raw_contains_sandbox_flag():
    """raw field always contains sandbox: True."""
    kora = Kora(sandbox=True)
    result = kora.spend("aws", 5000, "EUR")
    assert result.raw["sandbox"] is True


# --- Existing exports unchanged ---

def test_existing_exports_unchanged():
    """Kora and KoraEngine are both still exported."""
    from kora import Kora as K, KoraEngine
    assert callable(K)
    assert callable(KoraEngine)
