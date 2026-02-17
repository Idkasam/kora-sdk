"""Dataclasses for Kora SDK response types."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class NotarySeal:
    """Ed25519 notary seal attached to authorization decisions."""
    signature: str
    public_key_id: str
    algorithm: str
    signed_fields: list[str]
    timestamp: str
    payload_hash: str | None = None


@dataclass
class Limits:
    """Budget limits (remaining or spent)."""
    daily_remaining_cents: int | None = None
    monthly_remaining_cents: int | None = None
    daily_spent_cents: int | None = None
    monthly_spent_cents: int | None = None
    daily_limit_cents: int | None = None
    monthly_limit_cents: int | None = None


@dataclass
class PaymentInstruction:
    """Payment routing details."""
    recipient_iban: str | None = None
    recipient_name: str | None = None
    recipient_bic: str | None = None
    payment_reference: str | None = None


@dataclass
class DenialObject:
    """Structured denial information."""
    reason_code: str
    message: str
    hint: str
    actionable: dict[str, Any]
    failed_check: dict[str, Any] | None = None


@dataclass
class TraceStep:
    """Single evaluation pipeline step."""
    step: int
    check: str
    result: str
    duration_ms: int | None = None
    input: dict[str, Any] | None = None


@dataclass
class EvaluationTrace:
    """Full evaluation trace from the pipeline."""
    steps: list[TraceStep]
    total_duration_ms: int


@dataclass
class AuthorizationResult:
    """Result of an authorization request."""
    decision_id: str
    intent_id: str
    decision: str
    reason_code: str
    agent_id: str
    mandate_id: str | None
    mandate_version: int | None
    amount_cents: int | None
    currency: str | None
    vendor_id: str | None
    evaluated_at: str
    expires_at: str | None
    ttl_seconds: int | None
    notary_seal: NotarySeal | None
    limits_after_approval: Limits | None
    limits_current: Limits | None
    payment_instruction: PaymentInstruction | None
    denial: DenialObject | None
    evaluation_trace: EvaluationTrace | None
    trace_url: str | None
    executable: bool
    enforcement_mode: str | None
    simulated: bool

    @property
    def approved(self) -> bool:
        """True if the authorization was approved."""
        return self.decision == "APPROVED"

    @property
    def is_valid(self) -> bool:
        """True if the decision has not expired (TTL check)."""
        if not self.expires_at:
            return True
        return datetime.fromisoformat(self.expires_at) > datetime.now(timezone.utc)

    @property
    def is_enforced(self) -> bool:
        """True if enforcement_mode is 'enforce' (not log_only)."""
        return (self.enforcement_mode or "enforce") == "enforce"
