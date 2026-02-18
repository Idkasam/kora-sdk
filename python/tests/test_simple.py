"""Unit tests for the simplified Kora SDK (kora_simple.py).

Tests SpendResult/BudgetResult construction, format_amount, denial logging,
and package exports. Does NOT test live API calls (see test_e2e.py).
"""
from __future__ import annotations

import io
import sys
from unittest.mock import MagicMock, patch

import pytest

from kora.format import format_amount
from kora.kora_simple import (
    Kora,
    SpendResult,
    BudgetResult,
    _build_spend_result,
    _parse_budget_result,
)
from kora.types import (
    AuthorizationResult,
    DenialObject,
    PaymentInstruction,
    NotarySeal,
)


# ---------------------------------------------------------------------------
# format_amount tests (spec A.4.1)
# ---------------------------------------------------------------------------

class TestFormatAmount:
    def test_eur(self):
        assert format_amount(5000, "EUR") == "\u20ac50.00"

    def test_usd(self):
        assert format_amount(150, "USD") == "$1.50"

    def test_gbp(self):
        assert format_amount(9999, "GBP") == "\u00a399.99"

    def test_sek(self):
        assert format_amount(1000000, "SEK") == "kr10000.00"

    def test_zero(self):
        assert format_amount(0, "EUR") == "\u20ac0.00"

    def test_unknown_currency(self):
        assert format_amount(5000, "CHF") == "CHF 50.00"

    def test_lowercase_currency(self):
        assert format_amount(5000, "eur") == "\u20ac50.00"


# ---------------------------------------------------------------------------
# SpendResult message construction
# ---------------------------------------------------------------------------

class TestSpendResultMessage:
    def _make_approved_result(self) -> AuthorizationResult:
        return AuthorizationResult(
            decision_id="dec-123",
            intent_id="int-456",
            decision="APPROVED",
            reason_code="OK",
            agent_id="agent_001",
            mandate_id="mandate_abc",
            mandate_version=1,
            amount_cents=5000,
            currency="EUR",
            vendor_id="aws",
            evaluated_at="2026-02-15T10:00:00+00:00",
            expires_at="2026-02-15T10:05:00+00:00",
            ttl_seconds=300,
            notary_seal=NotarySeal(
                signature="sig",
                public_key_id="k1",
                algorithm="Ed25519",
                signed_fields=["intent_id"],
                timestamp="2026-02-15T10:00:00+00:00",
            ),
            limits_after_approval=None,
            limits_current=None,
            payment_instruction=PaymentInstruction(
                recipient_iban="DE89370400440532013000",
                recipient_bic="COBADEFFXXX",
                recipient_name="AWS Inc",
                payment_reference=None,
            ),
            denial=None,
            evaluation_trace=None,
            trace_url="/v1/authorizations/dec-123/trace",
            executable=True,
            enforcement_mode="enforce",
            simulated=False,
        )

    def _make_denied_result(self) -> AuthorizationResult:
        return AuthorizationResult(
            decision_id="dec-456",
            intent_id="int-789",
            decision="DENIED",
            reason_code="DAILY_LIMIT_EXCEEDED",
            agent_id="agent_001",
            mandate_id="mandate_abc",
            mandate_version=1,
            amount_cents=50000,
            currency="EUR",
            vendor_id="aws",
            evaluated_at="2026-02-15T10:00:00+00:00",
            expires_at=None,
            ttl_seconds=None,
            notary_seal=None,
            limits_after_approval=None,
            limits_current=None,
            payment_instruction=None,
            denial=DenialObject(
                reason_code="DAILY_LIMIT_EXCEEDED",
                message="Daily limit exceeded. Requested: 50000 cents, Available: 1200 cents.",
                hint="Reduce amount to 1200 or wait for daily reset.",
                actionable={"available_cents": 1200, "next_reset_at": "2026-02-16T00:00:00+01:00"},
            ),
            evaluation_trace=None,
            trace_url="/v1/authorizations/dec-456/trace",
            executable=False,
            enforcement_mode="enforce",
            simulated=False,
        )

    def test_approved_message(self):
        """APPROVED → message is 'Approved: €50.00 to aws'"""
        result = self._make_approved_result()
        with patch.object(Kora, "__init__", lambda *a, **kw: None):
            kora = Kora.__new__(Kora)
            kora._engine = MagicMock()
            kora._engine.authorize.return_value = result
            kora._mandate = "mandate_abc"
            kora._agent_id = "agent_001"
            kora._log_denials = False
            kora._base_url = "http://localhost:8000"

            spend = kora.spend("aws", 5000, "EUR")
            assert spend.approved is True
            assert spend.message == "Approved: \u20ac50.00 to aws"
            assert spend.suggestion is None
            assert spend.retry_with is None

    def test_denied_message(self):
        """DENIED → message from V1 denial.message"""
        result = self._make_denied_result()
        with patch.object(Kora, "__init__", lambda *a, **kw: None):
            kora = Kora.__new__(Kora)
            kora._engine = MagicMock()
            kora._engine.authorize.return_value = result
            kora._mandate = "mandate_abc"
            kora._agent_id = "agent_001"
            kora._log_denials = False
            kora._base_url = "http://localhost:8000"

            spend = kora.spend("aws", 50000, "EUR")
            assert spend.approved is False
            assert "Daily limit exceeded" in spend.message

    def test_denied_suggestion(self):
        """DENIED → suggestion from V1 denial.hint"""
        result = self._make_denied_result()
        with patch.object(Kora, "__init__", lambda *a, **kw: None):
            kora = Kora.__new__(Kora)
            kora._engine = MagicMock()
            kora._engine.authorize.return_value = result
            kora._mandate = "mandate_abc"
            kora._agent_id = "agent_001"
            kora._log_denials = False
            kora._base_url = "http://localhost:8000"

            spend = kora.spend("aws", 50000, "EUR")
            assert spend.suggestion is not None
            assert "1200" in spend.suggestion

    def test_denied_retry_with(self):
        """DENIED → retryWith from actionable.available_cents"""
        result = self._make_denied_result()
        with patch.object(Kora, "__init__", lambda *a, **kw: None):
            kora = Kora.__new__(Kora)
            kora._engine = MagicMock()
            kora._engine.authorize.return_value = result
            kora._mandate = "mandate_abc"
            kora._agent_id = "agent_001"
            kora._log_denials = False
            kora._base_url = "http://localhost:8000"

            spend = kora.spend("aws", 50000, "EUR")
            assert spend.retry_with == {"amount_cents": 1200}

    def test_approved_payment(self):
        """APPROVED → payment from V1 payment_instruction"""
        result = self._make_approved_result()
        with patch.object(Kora, "__init__", lambda *a, **kw: None):
            kora = Kora.__new__(Kora)
            kora._engine = MagicMock()
            kora._engine.authorize.return_value = result
            kora._mandate = "mandate_abc"
            kora._agent_id = "agent_001"
            kora._log_denials = False
            kora._base_url = "http://localhost:8000"

            spend = kora.spend("aws", 5000, "EUR")
            assert spend.payment is not None
            assert spend.payment["iban"] == "DE89370400440532013000"
            assert spend.payment["bic"] == "COBADEFFXXX"
            assert spend.payment["name"] == "AWS Inc"

    def test_approved_has_seal(self):
        """APPROVED → seal is present"""
        result = self._make_approved_result()
        with patch.object(Kora, "__init__", lambda *a, **kw: None):
            kora = Kora.__new__(Kora)
            kora._engine = MagicMock()
            kora._engine.authorize.return_value = result
            kora._mandate = "mandate_abc"
            kora._agent_id = "agent_001"
            kora._log_denials = False
            kora._base_url = "http://localhost:8000"

            spend = kora.spend("aws", 5000, "EUR")
            assert spend.seal is not None
            assert spend.seal["algorithm"] == "Ed25519"


# ---------------------------------------------------------------------------
# Stderr denial logging
# ---------------------------------------------------------------------------

class TestDenialLogging:
    def test_denied_emits_stderr(self):
        """DENIED → stderr log line emitted"""
        result = AuthorizationResult(
            decision_id="dec-456",
            intent_id="int-789",
            decision="DENIED",
            reason_code="DAILY_LIMIT_EXCEEDED",
            agent_id="agent_001",
            mandate_id="mandate_abc",
            mandate_version=1,
            amount_cents=50000,
            currency="EUR",
            vendor_id="aws",
            evaluated_at="2026-02-15T10:00:00+00:00",
            expires_at=None,
            ttl_seconds=None,
            notary_seal=None,
            limits_after_approval=None,
            limits_current=None,
            payment_instruction=None,
            denial=DenialObject(
                reason_code="DAILY_LIMIT_EXCEEDED",
                message="Daily limit exceeded.",
                hint="Reduce amount.",
                actionable={"available_cents": 1200},
            ),
            evaluation_trace=None,
            trace_url="/v1/authorizations/dec-456/trace",
            executable=False,
            enforcement_mode="enforce",
            simulated=False,
        )

        with patch.object(Kora, "__init__", lambda *a, **kw: None):
            kora = Kora.__new__(Kora)
            kora._engine = MagicMock()
            kora._engine.authorize.return_value = result
            kora._mandate = "mandate_abc"
            kora._agent_id = "agent_001"
            kora._log_denials = True
            kora._base_url = "http://localhost:8000"

            captured = io.StringIO()
            with patch("sys.stderr", captured):
                kora.spend("aws", 50000, "EUR")

            line = captured.getvalue().strip()
            assert line.startswith("KORA_DENIAL")
            assert "agent=agent_001" in line
            assert "mandate=mandate_abc" in line
            assert "vendor=aws" in line
            assert "amount=50000" in line
            assert "currency=EUR" in line
            assert "reason=DAILY_LIMIT_EXCEEDED" in line
            assert "remaining_cents=1200" in line
            assert "trace=" in line

    def test_approved_no_stderr(self):
        """APPROVED → NO stderr log line"""
        result = AuthorizationResult(
            decision_id="dec-123",
            intent_id="int-456",
            decision="APPROVED",
            reason_code="OK",
            agent_id="agent_001",
            mandate_id="mandate_abc",
            mandate_version=1,
            amount_cents=5000,
            currency="EUR",
            vendor_id="aws",
            evaluated_at="2026-02-15T10:00:00+00:00",
            expires_at="2026-02-15T10:05:00+00:00",
            ttl_seconds=300,
            notary_seal=None,
            limits_after_approval=None,
            limits_current=None,
            payment_instruction=None,
            denial=None,
            evaluation_trace=None,
            trace_url=None,
            executable=True,
            enforcement_mode="enforce",
            simulated=False,
        )

        with patch.object(Kora, "__init__", lambda *a, **kw: None):
            kora = Kora.__new__(Kora)
            kora._engine = MagicMock()
            kora._engine.authorize.return_value = result
            kora._mandate = "mandate_abc"
            kora._agent_id = "agent_001"
            kora._log_denials = True
            kora._base_url = "http://localhost:8000"

            captured = io.StringIO()
            with patch("sys.stderr", captured):
                kora.spend("aws", 5000, "EUR")

            assert captured.getvalue() == ""

    def test_log_denials_false_no_stderr(self):
        """log_denials=False → no stderr even on denial"""
        result = AuthorizationResult(
            decision_id="dec-456",
            intent_id="int-789",
            decision="DENIED",
            reason_code="VENDOR_NOT_ALLOWED",
            agent_id="agent_001",
            mandate_id="mandate_abc",
            mandate_version=1,
            amount_cents=5000,
            currency="EUR",
            vendor_id="gcp",
            evaluated_at="2026-02-15T10:00:00+00:00",
            expires_at=None,
            ttl_seconds=None,
            notary_seal=None,
            limits_after_approval=None,
            limits_current=None,
            payment_instruction=None,
            denial=DenialObject(
                reason_code="VENDOR_NOT_ALLOWED",
                message="Vendor not allowed.",
                hint="Use allowed vendor.",
                actionable={},
            ),
            evaluation_trace=None,
            trace_url="/v1/authorizations/dec-456/trace",
            executable=False,
            enforcement_mode="enforce",
            simulated=False,
        )

        with patch.object(Kora, "__init__", lambda *a, **kw: None):
            kora = Kora.__new__(Kora)
            kora._engine = MagicMock()
            kora._engine.authorize.return_value = result
            kora._mandate = "mandate_abc"
            kora._agent_id = "agent_001"
            kora._log_denials = False
            kora._base_url = "http://localhost:8000"

            captured = io.StringIO()
            with patch("sys.stderr", captured):
                kora.spend("gcp", 5000, "EUR")

            assert captured.getvalue() == ""


# ---------------------------------------------------------------------------
# BudgetResult parsing
# ---------------------------------------------------------------------------

class TestBudgetResult:
    def test_parse_full_budget(self):
        raw = {
            "mandate_id": "mandate_abc123",
            "currency": "EUR",
            "status": "active",
            "spend_allowed": True,
            "enforcement_mode": "enforce",
            "daily": {
                "limit_cents": 50000,
                "spent_cents": 38000,
                "remaining_cents": 12000,
                "resets_at": "2026-02-16T00:00:00+01:00",
            },
            "monthly": {
                "limit_cents": 500000,
                "spent_cents": 234000,
                "remaining_cents": 266000,
                "resets_at": "2026-03-01T00:00:00+01:00",
            },
            "per_transaction_max_cents": 10000,
            "velocity": {
                "window_max_cents": 20000,
                "window_spent_cents": 15000,
                "window_remaining_cents": 5000,
                "window_resets_in_seconds": 847,
            },
            "allowed_vendors": ["aws", "openai", "stripe"],
            "allowed_categories": ["compute", "api_services"],
            "time_window": {
                "allowed_days": ["mon", "tue", "wed", "thu", "fri"],
                "allowed_hours_local": {"start": "08:00", "end": "18:00"},
                "currently_open": True,
                "next_open_at": None,
            },
            "checked_at": "2026-02-15T14:32:00.000Z",
        }

        budget = _parse_budget_result(raw)
        assert budget.currency == "EUR"
        assert budget.status == "active"
        assert budget.spend_allowed is True
        assert budget.enforcement_mode == "enforce"
        assert budget.daily.limit_cents == 50000
        assert budget.daily.spent_cents == 38000
        assert budget.daily.remaining_cents == 12000
        assert budget.monthly.limit_cents == 500000
        assert budget.per_transaction_max_cents == 10000
        assert budget.velocity is not None
        assert budget.velocity.window_max_cents == 20000
        assert budget.allowed_vendors == ["aws", "openai", "stripe"]
        assert budget.allowed_categories == ["compute", "api_services"]
        assert budget.time_window is not None
        assert budget.time_window.currently_open is True

    def test_parse_suspended_budget(self):
        raw = {
            "mandate_id": "mandate_abc",
            "currency": "EUR",
            "status": "suspended",
            "spend_allowed": False,
            "enforcement_mode": "enforce",
            "daily": {"limit_cents": 50000, "spent_cents": 0, "remaining_cents": 50000, "resets_at": "2026-02-16T00:00:00Z"},
            "monthly": {"limit_cents": 500000, "spent_cents": 0, "remaining_cents": 500000, "resets_at": "2026-03-01T00:00:00Z"},
            "checked_at": "2026-02-15T14:32:00.000Z",
        }

        budget = _parse_budget_result(raw)
        assert budget.spend_allowed is False
        assert budget.status == "suspended"
        assert budget.per_transaction_max_cents is None
        assert budget.velocity is None
        assert budget.allowed_vendors is None
        assert budget.allowed_categories is None
        assert budget.time_window is None


# ---------------------------------------------------------------------------
# Package exports
# ---------------------------------------------------------------------------

class TestExports:
    def test_kora_is_simplified(self):
        from kora import Kora as ImportedKora
        from kora.kora_simple import Kora as SimpleKora
        assert ImportedKora is SimpleKora

    def test_kora_engine_is_v1(self):
        from kora import KoraEngine
        from kora.client import Kora as V1Kora
        assert KoraEngine is V1Kora

    def test_spend_result_exported(self):
        from kora import SpendResult
        assert SpendResult is not None

    def test_budget_result_exported(self):
        from kora import BudgetResult
        assert BudgetResult is not None

    def test_format_amount_exported(self):
        from kora import format_amount
        assert format_amount(5000, "EUR") == "\u20ac50.00"


# ---------------------------------------------------------------------------
# Response version compatibility (B.6.1)
# ---------------------------------------------------------------------------

class TestResponseVersionCompat:
    def test_parse_old_response_shape(self):
        """SDK handles pre-v1.3 response (has payment_instruction, no amount_cents at root)."""
        old_response = {
            "decision_id": "a1b2c3d4",
            "intent_id": "e5f6a7b8",
            "decision": "APPROVED",
            "reason_code": "OK",
            "mandate_id": "mandate_abc",
            "mandate_version": 1,
            "evaluated_at": "2026-02-18T12:00:00.000Z",
            "expires_at": "2026-02-18T12:05:00.000Z",
            "ttl_seconds": 300,
            "payment_instruction": {
                "recipient_iban": "DE89370400440532013000",
                "recipient_name": "AWS EMEA SARL",
                "recipient_bic": "COBADEFFXXX",
                "reference": "KORA-a1b2c3d4-MV1",
                "amount_cents": 5000,
                "currency": "EUR",
            },
            "executable": True,
            "notary_seal": {"algorithm": "Ed25519", "signature": "abc123"},
            "limits_after_approval": {
                "daily_remaining_cents": 95000,
                "monthly_remaining_cents": 495000,
            },
        }
        result = _build_spend_result(old_response)
        assert result.approved is True
        assert result.decision_id == "a1b2c3d4"
        assert result.decision == "APPROVED"
        assert result.reason_code == "OK"
        assert result.payment is not None
        assert result.payment["iban"] == "DE89370400440532013000"
        assert result.payment["bic"] == "COBADEFFXXX"
        assert result.payment["name"] == "AWS EMEA SARL"
        assert result.payment["reference"] == "KORA-a1b2c3d4-MV1"
        assert result.executable is True
        assert result.seal is not None
        assert result.seal["algorithm"] == "Ed25519"
        assert result.raw is old_response  # passthrough (no "raw" key in dict)

    def test_parse_future_response_shape(self):
        """SDK handles future response (no payment_instruction, has enforcement_mode/amount_cents/vendor_id)."""
        future_response = {
            "decision_id": "a1b2c3d4",
            "intent_id": "e5f6a7b8",
            "decision": "APPROVED",
            "reason_code": "OK",
            "mandate_id": "mandate_abc",
            "mandate_version": 1,
            "amount_cents": 5000,
            "currency": "EUR",
            "vendor_id": "aws",
            "enforcement_mode": "enforce",
            "evaluated_at": "2026-02-18T12:00:00.000Z",
            "expires_at": "2026-02-18T12:05:00.000Z",
            "ttl_seconds": 300,
            "notary_seal": {"algorithm": "Ed25519", "signature": "abc123"},
            "limits_after_approval": {
                "daily_remaining_cents": 95000,
                "monthly_remaining_cents": 495000,
            },
        }
        result = _build_spend_result(future_response)
        assert result.approved is True
        assert result.decision_id == "a1b2c3d4"
        assert result.payment is None  # no payment_instruction → None
        assert result.executable is True  # defaults to True
        assert result.seal is not None
        assert result.seal["algorithm"] == "Ed25519"
        assert result.raw is future_response

    def test_parse_denied_with_denial_object(self):
        """Denied response with denial sub-object extracts message/suggestion/retry_with."""
        denied_response = {
            "decision_id": "dec-999",
            "decision": "DENIED",
            "reason_code": "DAILY_LIMIT_EXCEEDED",
            "denial": {
                "message": "Daily limit exceeded.",
                "hint": "Reduce amount to 1200.",
                "actionable": {"available_cents": 1200},
            },
            "executable": False,
        }
        result = _build_spend_result(denied_response)
        assert result.approved is False
        assert result.message == "Daily limit exceeded."
        assert result.suggestion == "Reduce amount to 1200."
        assert result.retry_with == {"amount_cents": 1200}
        assert result.payment is None
        assert result.seal is None
        assert result.executable is False

    def test_parse_missing_executable_defaults_true(self):
        """Missing executable field defaults to True (forward-compat)."""
        response = {
            "decision_id": "dec-100",
            "decision": "APPROVED",
            "reason_code": "OK",
        }
        result = _build_spend_result(response)
        assert result.executable is True
