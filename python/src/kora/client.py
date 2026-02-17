"""Kora SDK client."""
from __future__ import annotations

import base64
import os
import sys
import uuid
from typing import Any

import requests

from .crypto import (
    build_signed_fields,
    canonicalize,
    parse_agent_key,
    sign_message,
    verify_seal as verify_seal_crypto,
)
from .errors import KoraError
from .types import (
    AuthorizationResult,
    DenialObject,
    EvaluationTrace,
    Limits,
    NotarySeal,
    PaymentInstruction,
    TraceStep,
)

_DEFAULT_BASE_URL = "http://localhost:8000"
_DEFAULT_TTL = 300
_DEFAULT_MAX_RETRIES = 2


class Kora:
    """Kora authorization SDK client.

    Example::

        kora = Kora('kora_agent_sk_...')
        auth = kora.authorize(
            mandate='mandate_abc123',
            amount=50_00,
            currency='EUR',
            vendor='aws',
        )
        if auth.approved:
            print(f"Approved! Decision: {auth.decision_id}")
    """

    def __init__(
        self,
        key_string: str,
        *,
        base_url: str = _DEFAULT_BASE_URL,
        ttl: int = _DEFAULT_TTL,
        max_retries: int = _DEFAULT_MAX_RETRIES,
    ):
        agent_id, signing_key = parse_agent_key(key_string)
        self._agent_id = agent_id
        self._signing_key = signing_key
        self._base_url = base_url
        self._default_ttl = ttl
        self._max_retries = max_retries

    def authorize(
        self,
        *,
        mandate: str,
        amount: int,
        currency: str,
        vendor: str,
        category: str | None = None,
        purpose: str | None = None,
        ttl: int | None = None,
        payment_instruction: dict[str, str] | None = None,
        metadata: dict[str, Any] | None = None,
        simulate: str | None = None,
        admin_key: str | None = None,
    ) -> AuthorizationResult:
        """Submit an authorization request.

        Returns an AuthorizationResult. On DENIED decisions, logs the trace URL
        to stderr. On network errors, retries with the same intent_id.
        """
        intent_id = str(uuid.uuid4())
        ttl_seconds = ttl or self._default_ttl
        last_error: Exception | None = None

        for attempt in range(self._max_retries + 1):
            nonce = base64.b64encode(os.urandom(16)).decode("ascii")

            # Build and sign
            signed_fields = build_signed_fields(
                intent_id=intent_id,
                agent_id=self._agent_id,
                mandate_id=mandate,
                amount_cents=amount,
                currency=currency,
                vendor_id=vendor,
                nonce=nonce,
                ttl_seconds=ttl_seconds,
                payment_instruction=payment_instruction,
                metadata=metadata,
            )
            canonical = canonicalize(signed_fields)
            signature = sign_message(canonical, self._signing_key)

            # Build request body
            body: dict[str, Any] = {
                "intent_id": intent_id,
                "agent_id": self._agent_id,
                "mandate_id": mandate,
                "amount_cents": amount,
                "currency": currency,
                "vendor_id": vendor,
                "nonce": nonce,
                "ttl_seconds": ttl_seconds,
            }
            if category:
                body["category"] = category
            if purpose:
                body["purpose"] = purpose
            if payment_instruction:
                body["payment_instruction"] = payment_instruction
            if metadata:
                body["metadata"] = metadata

            headers: dict[str, str] = {
                "Content-Type": "application/json",
                "X-Agent-Signature": signature,
                "X-Agent-Id": self._agent_id,
            }

            # Simulation headers
            if simulate:
                headers["X-Kora-Simulate"] = simulate
                if admin_key:
                    headers["Authorization"] = f"Bearer {admin_key}"

            try:
                resp = requests.post(
                    f"{self._base_url}/v1/authorize",
                    json=body,
                    headers=headers,
                    timeout=30,
                )
                raw = resp.json()

                if resp.status_code >= 400:
                    raise KoraError(
                        raw.get("error", "UNKNOWN_ERROR"),
                        raw.get("message", f"HTTP {resp.status_code}"),
                        resp.status_code,
                    )

                result = parse_response(raw)

                # Log trace URL on denial
                if result.decision == "DENIED" and result.trace_url:
                    print(
                        f"[kora] DENIED: {result.reason_code}"
                        f" — trace: {self._base_url}{result.trace_url}",
                        file=sys.stderr,
                    )

                return result

            except KoraError:
                raise
            except (requests.ConnectionError, requests.Timeout) as exc:
                if attempt == self._max_retries:
                    raise
                last_error = exc
            except Exception:
                raise

        raise last_error or RuntimeError("Authorization failed after retries")

    def verify_seal(
        self, result: AuthorizationResult, kora_public_key: str
    ) -> bool:
        """Verify a notary seal on an authorization result."""
        if not result.notary_seal:
            return False

        seal = result.notary_seal
        field_map: dict[str, Any] = {
            "intent_id": result.intent_id,
            "mandate_id": result.mandate_id,
            "mandate_version": result.mandate_version,
            "status": result.decision,
            "reason_code": result.reason_code,
            "amount_cents": result.amount_cents,
            "currency": result.currency,
            "vendor_id": result.vendor_id,
            "evaluated_at": result.evaluated_at,
            "ttl_seconds": result.ttl_seconds,
            "enforcement_mode": result.enforcement_mode,
            "executable": result.executable,
        }

        decision_payload: dict[str, Any] = {}
        for f in seal.signed_fields:
            if f in field_map:
                decision_payload[f] = field_map[f]

        return verify_seal_crypto(
            decision_payload, seal.signature, kora_public_key
        )

    def as_tool(
        self,
        mandate: str,
        category_enum: list[str] | None = None,
    ) -> dict[str, Any]:
        """Generate an OpenAI function calling schema for authorization."""
        properties: dict[str, Any] = {
            "amount_cents": {
                "type": "integer",
                "description": "Amount in cents (positive integer)",
            },
            "currency": {
                "type": "string",
                "description": "3-character ISO 4217 currency code (e.g. EUR, USD)",
            },
            "vendor_id": {
                "type": "string",
                "description": "Vendor identifier (e.g. aws, stripe, openai)",
            },
        }

        if category_enum:
            properties["category"] = {
                "type": "string",
                "enum": category_enum,
                "description": "Spend category",
            }
        else:
            properties["category"] = {
                "type": "string",
                "description": "Spend category (optional)",
            }

        properties["purpose"] = {
            "type": "string",
            "description": "Human-readable purpose for the spend",
        }

        return {
            "type": "function",
            "function": {
                "name": "kora_authorize_spend",
                "description": (
                    f"Request authorization to spend money via Kora. "
                    f"Mandate: {mandate}. "
                    f"Returns APPROVED or DENIED with reason code."
                ),
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": ["amount_cents", "currency", "vendor_id"],
                },
            },
        }


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------


def parse_response(raw: dict[str, Any]) -> AuthorizationResult:
    """Parse a raw API response dict into an AuthorizationResult."""
    decision = raw.get("decision") or raw.get("status") or "DENIED"
    evaluated_at = raw.get("evaluated_at", "")
    expires_at = raw.get("expires_at")

    return AuthorizationResult(
        decision_id=raw.get("decision_id", ""),
        intent_id=raw.get("intent_id", ""),
        decision=decision,
        reason_code=raw.get("reason_code", ""),
        agent_id=raw.get("agent_id", ""),
        mandate_id=raw.get("mandate_id"),
        mandate_version=raw.get("mandate_version"),
        amount_cents=raw.get("amount_cents"),
        currency=raw.get("currency"),
        vendor_id=raw.get("vendor_id"),
        evaluated_at=evaluated_at,
        expires_at=expires_at,
        ttl_seconds=raw.get("ttl_seconds"),
        notary_seal=_parse_seal(raw["notary_seal"]) if raw.get("notary_seal") else None,
        limits_after_approval=(
            _parse_limits(raw["limits_after_approval"])
            if raw.get("limits_after_approval")
            else None
        ),
        limits_current=(
            _parse_limits(raw["limits_current"])
            if raw.get("limits_current")
            else None
        ),
        payment_instruction=(
            _parse_payment_instruction(raw["payment_instruction"])
            if raw.get("payment_instruction")
            else None
        ),
        denial=_parse_denial(raw["denial"]) if raw.get("denial") else None,
        evaluation_trace=(
            _parse_trace(raw["evaluation_trace"])
            if raw.get("evaluation_trace")
            else None
        ),
        trace_url=raw.get("trace_url"),
        executable=raw.get("executable", False),
        enforcement_mode=raw.get("enforcement_mode"),
        simulated=raw.get("simulated", False),
    )


def _parse_seal(raw: dict[str, Any]) -> NotarySeal:
    return NotarySeal(
        signature=raw["signature"],
        public_key_id=raw["public_key_id"],
        algorithm=raw["algorithm"],
        signed_fields=raw["signed_fields"],
        timestamp=raw["timestamp"],
        payload_hash=raw.get("payload_hash"),
    )


def _parse_limits(raw: dict[str, Any]) -> Limits:
    return Limits(
        daily_remaining_cents=raw.get("daily_remaining_cents"),
        monthly_remaining_cents=raw.get("monthly_remaining_cents"),
        daily_spent_cents=raw.get("daily_spent_cents"),
        monthly_spent_cents=raw.get("monthly_spent_cents"),
        daily_limit_cents=raw.get("daily_limit_cents"),
        monthly_limit_cents=raw.get("monthly_limit_cents"),
    )


def _parse_payment_instruction(raw: dict[str, Any]) -> PaymentInstruction:
    return PaymentInstruction(
        recipient_iban=raw.get("recipient_iban"),
        recipient_name=raw.get("recipient_name"),
        recipient_bic=raw.get("recipient_bic"),
        payment_reference=raw.get("payment_reference"),
    )


def _parse_denial(raw: dict[str, Any]) -> DenialObject:
    return DenialObject(
        reason_code=raw.get("reason_code", ""),
        message=raw.get("message", ""),
        hint=raw.get("hint", ""),
        actionable=raw.get("actionable", {}),
        failed_check=raw.get("failed_check"),
    )


def _parse_trace(raw: dict[str, Any]) -> EvaluationTrace:
    return EvaluationTrace(
        steps=[
            TraceStep(
                step=s.get("step", 0),
                check=s.get("check", ""),
                result=s.get("result", ""),
                duration_ms=s.get("duration_ms"),
                input=s.get("input"),
            )
            for s in raw.get("steps", [])
        ],
        total_duration_ms=raw.get("total_duration_ms", 0),
    )
