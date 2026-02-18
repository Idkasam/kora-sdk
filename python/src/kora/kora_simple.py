"""Simplified Kora SDK — spend() and check_budget() with two-method API.

This is the recommended interface for most agent integrations.
For advanced use (verify_seal, as_tool, simulation), use KoraEngine directly.
"""
from __future__ import annotations

import base64
import os
import sys
import uuid
from dataclasses import dataclass
from typing import Any

import requests

from .client import Kora as KoraEngine
from .crypto import canonicalize, parse_agent_key, sign_message
from .errors import KoraError
from .format import format_amount


_DEFAULT_BASE_URL = "https://api.koraprotocol.com"


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class SpendResult:
    """Result of a spend() call."""
    approved: bool
    decision_id: str
    decision: str
    reason_code: str
    message: str
    suggestion: str | None
    retry_with: dict | None
    seal: dict | None
    enforcement_mode: str
    amount_cents: int | None
    currency: str | None
    vendor_id: str | None
    raw: dict


@dataclass
class _DailyBudget:
    limit_cents: int
    spent_cents: int
    remaining_cents: int
    resets_at: str


@dataclass
class _MonthlyBudget:
    limit_cents: int
    spent_cents: int
    remaining_cents: int
    resets_at: str


@dataclass
class _VelocityBudget:
    window_max_cents: int
    window_spent_cents: int
    window_remaining_cents: int
    window_resets_in_seconds: int


@dataclass
class _TimeWindowBudget:
    allowed_days: list[str]
    allowed_hours_local: dict[str, str]
    currently_open: bool
    next_open_at: str | None


@dataclass
class BudgetResult:
    """Result of a check_budget() call."""
    currency: str
    status: str
    spend_allowed: bool
    enforcement_mode: str
    daily: _DailyBudget
    monthly: _MonthlyBudget
    per_transaction_max_cents: int | None
    velocity: _VelocityBudget | None
    allowed_vendors: list[str] | None
    allowed_categories: list[str] | None
    time_window: _TimeWindowBudget | None
    raw: dict


# ---------------------------------------------------------------------------
# Simplified Kora class
# ---------------------------------------------------------------------------

class Kora:
    """Simplified Kora SDK — two methods: spend() and check_budget().

    Args:
        secret: Agent secret key (kora_agent_sk_...)
        mandate: Default mandate ID for all operations
        base_url: Kora API base URL
        log_denials: Emit KORA_DENIAL to stderr on denied results (default: True)
        sandbox: Run in sandbox mode (no network, in-memory limits)
        sandbox_config: Override default sandbox limits (see SandboxEngine)
    """

    # Class-level default so mocked instances (bypassing __init__) still work
    _sandbox = False

    def __init__(
        self,
        secret: str = None,
        mandate: str = None,
        base_url: str = _DEFAULT_BASE_URL,
        log_denials: bool = True,
        sandbox: bool = False,
        sandbox_config: dict = None,
    ):
        # Environment variable activation
        sandbox = sandbox or os.environ.get("KORA_SANDBOX", "").lower() in ("true", "1")

        self._sandbox = sandbox
        self._log_denials = log_denials
        self._base_url = base_url

        if sandbox:
            from .kora_sandbox import SandboxEngine
            self._engine = None
            self._sandbox_engine = SandboxEngine(sandbox_config)
            self._mandate = "sandbox_mandate"
            self._agent_id = "sandbox_agent"
            self._signing_key = None
        else:
            if not secret:
                raise ValueError("secret is required when sandbox=False")
            if not mandate:
                raise ValueError("mandate is required when sandbox=False")
            self._engine = KoraEngine(secret, base_url=base_url)
            self._sandbox_engine = None
            self._mandate = mandate
            self._agent_id = self._engine._agent_id
            self._signing_key = self._engine._signing_key

    def spend(
        self,
        vendor: str,
        amount_cents: int,
        currency: str,
        reason: str | None = None,
    ) -> SpendResult:
        """Request authorization to spend.

        Signs and submits to /v1/authorize via the underlying KoraEngine.
        On DENIED results, emits a structured KORA_DENIAL log line to stderr.
        """
        if self._sandbox:
            raw = self._sandbox_engine.spend(vendor, amount_cents, currency, reason)
            spend_result = _build_spend_result(raw)
            if not spend_result.approved and self._log_denials:
                self._log_denial(spend_result, vendor, amount_cents, currency)
            return spend_result

        # Build kwargs for engine.authorize()
        kwargs: dict[str, Any] = {
            "mandate": self._mandate,
            "amount": amount_cents,
            "currency": currency,
            "vendor": vendor,
        }
        if reason is not None:
            kwargs["purpose"] = reason

        result = self._engine.authorize(**kwargs)

        # Pre-compute message (needs input params for format_amount)
        if result.approved:
            message = f"Approved: {format_amount(amount_cents, currency)} to {vendor}"
        else:
            message = result.denial.message if result.denial else f"Denied: {result.reason_code}"

        suggestion = result.denial.hint if result.denial else None

        retry_with = None
        if result.denial and result.denial.actionable:
            available = result.denial.actionable.get("available_cents")
            if available is not None and available > 0:
                retry_with = {"amount_cents": available}

        seal = None
        if result.notary_seal:
            seal = {
                "signature": result.notary_seal.signature,
                "public_key_id": result.notary_seal.public_key_id,
                "algorithm": result.notary_seal.algorithm,
                "signed_fields": result.notary_seal.signed_fields,
                "timestamp": result.notary_seal.timestamp,
            }

        spend_result = _build_spend_result({
            "approved": result.approved,
            "decision_id": result.decision_id,
            "decision": result.decision,
            "reason_code": result.reason_code,
            "message": message,
            "suggestion": suggestion,
            "retry_with": retry_with,
            "seal": seal,
            "enforcement_mode": result.enforcement_mode,
            "amount_cents": result.amount_cents,
            "currency": result.currency,
            "vendor_id": result.vendor_id,
            "raw": _build_raw_dict(result),
        })

        # Stderr denial logging
        if not result.approved and self._log_denials:
            self._log_denial(spend_result, vendor, amount_cents, currency, result)

        return spend_result

    def sandbox_reset(self) -> None:
        """Reset all sandbox counters to zero. Only works in sandbox mode."""
        if not self._sandbox:
            raise RuntimeError("sandbox_reset() is only available in sandbox mode")
        self._sandbox_engine.reset()

    def check_budget(self) -> BudgetResult:
        """Check current budget for the configured mandate.

        Signs and submits to /v1/mandates/:id/budget.
        """
        if self._sandbox:
            raw = self._sandbox_engine.get_budget()
            return _parse_budget_result(raw)

        body = {"mandate_id": self._mandate}
        canonical = canonicalize(body)
        signature = sign_message(canonical, self._signing_key)

        headers = {
            "Content-Type": "application/json",
            "X-Agent-Id": self._agent_id,
            "X-Agent-Signature": signature,
        }

        resp = requests.post(
            f"{self._base_url}/v1/mandates/{self._mandate}/budget",
            json=body,
            headers=headers,
            timeout=30,
        )

        if resp.status_code == 404:
            raise KoraError("NOT_FOUND", "Mandate not found or revoked", 404)

        if resp.status_code >= 400:
            raw = resp.json()
            error = raw.get("error", {})
            raise KoraError(
                error.get("code", "UNKNOWN_ERROR"),
                error.get("message", f"HTTP {resp.status_code}"),
                resp.status_code,
            )

        raw = resp.json()
        return _parse_budget_result(raw)

    def _log_denial(
        self,
        spend_result: SpendResult,
        vendor: str,
        amount_cents: int,
        currency: str,
        engine_result: Any = None,
    ) -> None:
        """Emit structured KORA_DENIAL log line to stderr."""
        parts = [
            "KORA_DENIAL",
            f"agent={self._agent_id}",
            f"mandate={self._mandate}",
            f"vendor={vendor}",
            f"amount={amount_cents}",
            f"currency={currency}",
            f"reason={spend_result.reason_code}",
        ]

        # Include remaining_cents when available
        if spend_result.retry_with:
            parts.append(f"remaining_cents={spend_result.retry_with['amount_cents']}")

        # Trace URL (not available in sandbox mode)
        trace_url = engine_result.trace_url if engine_result and engine_result.trace_url else ""
        if trace_url:
            parts.append(f"trace={self._base_url}{trace_url}")

        print(" ".join(parts), file=sys.stderr)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_raw_dict(result: Any) -> dict:
    """Build a raw dict from an AuthorizationResult for SpendResult.raw."""
    raw: dict[str, Any] = {
        "decision_id": result.decision_id,
        "intent_id": result.intent_id,
        "decision": result.decision,
        "reason_code": result.reason_code,
        "agent_id": result.agent_id,
        "mandate_id": result.mandate_id,
        "evaluated_at": result.evaluated_at,
    }
    if result.amount_cents is not None:
        raw["amount_cents"] = result.amount_cents
    if result.currency is not None:
        raw["currency"] = result.currency
    if result.vendor_id is not None:
        raw["vendor_id"] = result.vendor_id
    if result.enforcement_mode is not None:
        raw["enforcement_mode"] = result.enforcement_mode
    return raw


def _build_spend_result(raw: dict) -> SpendResult:
    """Build SpendResult from a response dict.

    Tolerant of missing/extra fields — handles both current v1.3 API shape
    and old cached responses (pre-v1.3 with payment_instruction).
    Used by spend() and sandbox.

    NOTE: Idempotent replays of pre-v1.3 authorizations may return the old
    response shape (with payment_instruction, without amount_cents at root).
    Defensive parsing pulls amount_cents/currency from payment_instruction
    as fallback if not found at root level.
    """
    approved = raw.get("approved", raw.get("decision") == "APPROVED")

    # Message: direct field or extracted from denial
    message = raw.get("message", "")
    if not message:
        denial = raw.get("denial")
        if isinstance(denial, dict) and denial.get("message"):
            message = denial["message"]
        else:
            rc = raw.get("reason_code", "")
            message = f"Approved: {rc}" if approved else f"Denied: {rc}"

    # Suggestion: direct or from denial.hint
    suggestion = raw.get("suggestion")
    if suggestion is None and isinstance(raw.get("denial"), dict):
        suggestion = raw["denial"].get("hint")

    # retry_with: direct or from denial.actionable
    retry_with = raw.get("retry_with")
    if retry_with is None:
        denial = raw.get("denial")
        if isinstance(denial, dict) and isinstance(denial.get("actionable"), dict):
            available = denial["actionable"].get("available_cents")
            if available is not None and available > 0:
                retry_with = {"amount_cents": available}

    # Seal: from seal (sandbox) or notary_seal (production API)
    seal = raw.get("seal") or raw.get("notary_seal")
    if isinstance(seal, dict):
        seal = dict(seal)
    else:
        seal = None

    # Defensive parsing for backward compat with pre-v1.3 cached responses:
    # Old responses may have amount_cents/currency inside payment_instruction.
    pi_fallback = raw.get("payment_instruction") or {}
    if not isinstance(pi_fallback, dict):
        pi_fallback = {}
    enforcement_mode = raw.get("enforcement_mode", "enforce")
    amount_cents = raw.get("amount_cents", pi_fallback.get("amount_cents"))
    currency = raw.get("currency") or pi_fallback.get("currency")
    vendor_id = raw.get("vendor_id", None)

    return SpendResult(
        approved=approved,
        decision_id=raw.get("decision_id", ""),
        decision=raw.get("decision", ""),
        reason_code=raw.get("reason_code", ""),
        message=message,
        suggestion=suggestion,
        retry_with=retry_with,
        seal=seal,
        enforcement_mode=enforcement_mode,
        amount_cents=amount_cents,
        currency=currency,
        vendor_id=vendor_id,
        raw=raw.get("raw", raw),
    )


def _parse_budget_result(raw: dict) -> BudgetResult:
    """Parse raw budget API response into BudgetResult."""
    daily = raw["daily"]
    monthly = raw["monthly"]

    velocity = None
    if raw.get("velocity") is not None:
        v = raw["velocity"]
        velocity = _VelocityBudget(
            window_max_cents=v["window_max_cents"],
            window_spent_cents=v["window_spent_cents"],
            window_remaining_cents=v["window_remaining_cents"],
            window_resets_in_seconds=v["window_resets_in_seconds"],
        )

    time_window = None
    if raw.get("time_window") is not None:
        tw = raw["time_window"]
        time_window = _TimeWindowBudget(
            allowed_days=tw["allowed_days"],
            allowed_hours_local=tw["allowed_hours_local"],
            currently_open=tw["currently_open"],
            next_open_at=tw.get("next_open_at"),
        )

    return BudgetResult(
        currency=raw["currency"],
        status=raw["status"],
        spend_allowed=raw["spend_allowed"],
        enforcement_mode=raw.get("enforcement_mode", "enforce"),
        daily=_DailyBudget(
            limit_cents=daily["limit_cents"],
            spent_cents=daily["spent_cents"],
            remaining_cents=daily["remaining_cents"],
            resets_at=daily["resets_at"],
        ),
        monthly=_MonthlyBudget(
            limit_cents=monthly["limit_cents"],
            spent_cents=monthly["spent_cents"],
            remaining_cents=monthly["remaining_cents"],
            resets_at=monthly["resets_at"],
        ),
        per_transaction_max_cents=raw.get("per_transaction_max_cents"),
        velocity=velocity,
        allowed_vendors=raw.get("allowed_vendors"),
        allowed_categories=raw.get("allowed_categories"),
        time_window=time_window,
        raw=raw,
    )
