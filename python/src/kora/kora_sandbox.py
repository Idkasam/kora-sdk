"""Sandbox authorization engine — in-memory simulator with zero network calls.

Tracks daily/monthly spend counters, enforces limits, and returns dicts
matching the shape expected by _build_spend_result() and _parse_budget_result().
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timedelta, timezone

DEFAULT_SANDBOX_CONFIG = {
    "daily_limit_cents": 1_000_000,        # €10,000
    "monthly_limit_cents": 5_000_000,      # €50,000
    "currency": "EUR",
    "per_transaction_max_cents": None,      # None = no per-tx limit
    "allowed_vendors": None,               # None = all vendors allowed
}

SANDBOX_PAYMENT = {
    "iban": "XX00SANDBOX0000000001",
    "bic": "SANDBOXXXX",
    "name": "Sandbox Vendor",
}
# NOTE: Sandbox currently returns payment-related fields (payment, executable)
# for compatibility with the current server API response shape.
# These fields are DEPRECATED and will be removed when the server API
# drops payment_instruction from authorization responses (see
# KORA_REMOVE_PAYMENT_INSTRUCTION.md). When that happens:
#   - Delete this SANDBOX_PAYMENT dict
#   - Delete _build_sandbox_payment()
#   - Remove "payment" and "executable" keys from spend() return dict
# Real vendor routing (IBANs, Stripe IDs, etc.) is a V2 executor concern.
# These values are obviously fake and cannot be confused with real accounts.


class SandboxEngine:
    """In-memory authorization simulator. Zero network calls."""

    def __init__(self, config: dict = None):
        merged = {**DEFAULT_SANDBOX_CONFIG, **(config or {})}
        self.daily_limit = merged["daily_limit_cents"]
        self.monthly_limit = merged["monthly_limit_cents"]
        self.currency = merged["currency"]
        self.per_tx_max = merged["per_transaction_max_cents"]
        self.allowed_vendors = merged["allowed_vendors"]

        self.daily_spent = 0
        self.monthly_spent = 0
        self.tx_count = 0
        self._warned = False
        self._start_date = datetime.now(timezone.utc).date()

    def _warn_once(self):
        if not self._warned:
            print(
                "[KORA SANDBOX] Running in sandbox mode — no real authorizations are being made.",
                file=sys.stderr,
            )
            self._warned = True

    def _auto_reset_if_new_day(self):
        """Reset daily counter if date has changed since last call."""
        today = datetime.now(timezone.utc).date()
        if today != self._start_date:
            self.daily_spent = 0
            self._start_date = today
            # Monthly reset on 1st
            if today.day == 1:
                self.monthly_spent = 0

    def _format_euros(self, cents: int) -> str:
        """Format cents as €X,XXX.XX using integer math only (no floats)."""
        whole = cents // 100
        frac = cents % 100
        return f"€{whole:,}.{frac:02d}"

    def spend(self, vendor: str, amount_cents: int, currency: str, reason: str = None) -> dict:
        """Simulate authorization. Returns dict matching _build_spend_result() shape."""
        self._warn_once()
        self._auto_reset_if_new_day()

        # --- Input validation (mirrors production) ---
        if not isinstance(amount_cents, int) or amount_cents <= 0:
            raise ValueError("amount_cents must be a positive integer")
        if not vendor or not isinstance(vendor, str):
            raise ValueError("vendor must be a non-empty string")
        if not currency or not isinstance(currency, str) or len(currency) != 3:
            raise ValueError("currency must be a 3-letter ISO 4217 code")
        currency = currency.upper()
        vendor = vendor.strip().lower()

        decision_id = f"sandbox_{uuid.uuid4().hex}"
        now = datetime.now(timezone.utc)
        now_iso = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"

        # --- Evaluation pipeline ---
        # Order: currency → vendor allowlist → per-tx → daily → monthly

        # Currency check
        if currency != self.currency:
            return self._build_denied(
                decision_id, now_iso, amount_cents, currency, vendor,
                "CURRENCY_MISMATCH",
                f"Currency '{currency}' does not match mandate currency '{self.currency}'.",
                None, None,
            )

        # Vendor allowlist
        if self.allowed_vendors is not None and vendor not in self.allowed_vendors:
            return self._build_denied(
                decision_id, now_iso, amount_cents, currency, vendor,
                "VENDOR_NOT_ALLOWED",
                f"Vendor '{vendor}' is not in the allowed vendor list.",
                None, None,
            )

        # Per-transaction limit
        if self.per_tx_max is not None and amount_cents > self.per_tx_max:
            return self._build_denied(
                decision_id, now_iso, amount_cents, currency, vendor,
                "PER_TRANSACTION_LIMIT_EXCEEDED",
                f"Per-transaction limit exceeded. Maximum: {self._format_euros(self.per_tx_max)}.",
                f"Reduce amount to {self._format_euros(self.per_tx_max)}.",
                {"amount_cents": self.per_tx_max},
            )

        # Daily limit
        daily_remaining = self.daily_limit - self.daily_spent
        if amount_cents > daily_remaining:
            return self._build_denied(
                decision_id, now_iso, amount_cents, currency, vendor,
                "DAILY_LIMIT_EXCEEDED",
                f"Daily spending limit exceeded. Requested: {self._format_euros(amount_cents)}. Available: {self._format_euros(daily_remaining)}.",
                f"Reduce amount to {self._format_euros(daily_remaining)} or wait for daily reset.",
                {"amount_cents": daily_remaining} if daily_remaining > 0 else None,
            )

        # Monthly limit
        monthly_remaining = self.monthly_limit - self.monthly_spent
        if amount_cents > monthly_remaining:
            return self._build_denied(
                decision_id, now_iso, amount_cents, currency, vendor,
                "MONTHLY_LIMIT_EXCEEDED",
                f"Monthly spending limit exceeded. Requested: {self._format_euros(amount_cents)}. Available: {self._format_euros(monthly_remaining)}.",
                f"Reduce amount to {self._format_euros(monthly_remaining)} or wait for monthly reset.",
                {"amount_cents": monthly_remaining} if monthly_remaining > 0 else None,
            )

        # --- APPROVED ---
        self.daily_spent += amount_cents
        self.monthly_spent += amount_cents
        self.tx_count += 1

        short_id = uuid.uuid4().hex[:8]
        sig_hex = uuid.uuid4().hex
        expires = now + timedelta(seconds=300)
        expires_iso = expires.strftime("%Y-%m-%dT%H:%M:%S.") + f"{expires.microsecond // 1000:03d}Z"

        return {
            "approved": True,
            "decision_id": decision_id,
            "decision": "APPROVED",
            "reason_code": "OK",
            "message": f"Approved: {self._format_euros(amount_cents)} to {vendor}",
            "suggestion": None,
            "retry_with": None,
            # FORWARD-COMPAT: payment + executable will be removed in next change.
            # _build_sandbox_payment() isolates this so removal is one-line.
            "payment": self._build_sandbox_payment(short_id),
            "executable": True,
            # These fields are added for forward-compat with the upcoming
            # payment_instruction removal. They echo the authorization tuple.
            "enforcement_mode": "enforce",
            "amount_cents": amount_cents,
            "currency": currency,
            "vendor_id": vendor,
            "seal": {
                "algorithm": "Ed25519",
                "signature": f"sandbox_sig_{sig_hex[:32]}",
                "public_key_id": "sandbox_key_v1",
                "payload_hash": f"sha256:sandbox_{sig_hex[:16]}",
            },
            "raw": {
                "sandbox": True,
                "decision": "APPROVED",
                "decision_id": decision_id,
                "reason_code": "OK",
                "enforcement_mode": "enforce",
                "amount_cents": amount_cents,
                "currency": currency,
                "vendor_id": vendor,
                "evaluated_at": now_iso,
                "expires_at": expires_iso,
                "limits_after_approval": {
                    "daily_remaining_cents": self.daily_limit - self.daily_spent,
                    "monthly_remaining_cents": self.monthly_limit - self.monthly_spent,
                },
            },
        }

    @staticmethod
    def _build_sandbox_payment(short_id: str) -> dict:
        """Build sandbox payment details. Isolated for easy removal
        when payment_instruction is removed from API response."""
        return {
            "iban": SANDBOX_PAYMENT["iban"],
            "bic": SANDBOX_PAYMENT["bic"],
            "name": SANDBOX_PAYMENT["name"],
            "reference": f"KORA-SANDBOX-{short_id}",
        }

    def _build_denied(self, decision_id, now_iso, amount_cents, currency, vendor,
                      reason_code, message, suggestion, retry_with):
        return {
            "approved": False,
            "decision_id": decision_id,
            "decision": "DENIED",
            "reason_code": reason_code,
            "message": message,
            "suggestion": suggestion,
            "retry_with": retry_with,
            "payment": None,
            "executable": False,
            "seal": None,
            "raw": {
                "sandbox": True,
                "decision": "DENIED",
                "decision_id": decision_id,
                "reason_code": reason_code,
                "evaluated_at": now_iso,
                "limits_current": {
                    "daily_spent_cents": self.daily_spent,
                    "daily_limit_cents": self.daily_limit,
                    "monthly_spent_cents": self.monthly_spent,
                    "monthly_limit_cents": self.monthly_limit,
                },
            },
        }

    def get_budget(self) -> dict:
        """Return current sandbox budget state matching _parse_budget_result() shape."""
        self._warn_once()
        self._auto_reset_if_new_day()

        now = datetime.now(timezone.utc)
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        next_month = (now.replace(day=1) + timedelta(days=32)).replace(
            day=1, hour=0, minute=0, second=0, microsecond=0,
        )
        now_iso = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"

        return {
            "currency": self.currency,
            "status": "active",
            "spend_allowed": True,
            "enforcement_mode": "enforce",
            "daily": {
                "limit_cents": self.daily_limit,
                "spent_cents": self.daily_spent,
                "remaining_cents": self.daily_limit - self.daily_spent,
                "resets_at": tomorrow.strftime("%Y-%m-%dT%H:%M:%S") + "Z",
            },
            "monthly": {
                "limit_cents": self.monthly_limit,
                "spent_cents": self.monthly_spent,
                "remaining_cents": self.monthly_limit - self.monthly_spent,
                "resets_at": next_month.strftime("%Y-%m-%dT%H:%M:%S") + "Z",
            },
            "per_transaction_max_cents": self.per_tx_max,
            "velocity": None,
            "allowed_vendors": self.allowed_vendors,
            "allowed_categories": None,
            "time_window": None,
            "raw": {"sandbox": True, "checked_at": now_iso},
        }

    def reset(self):
        """Reset all counters."""
        self.daily_spent = 0
        self.monthly_spent = 0
        self.tx_count = 0
        self._start_date = datetime.now(timezone.utc).date()
