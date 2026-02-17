"""KoraAuto — scan-mode SDK for spend observation (no signing, no enforcement).

Emits spend-intent signals to Kora's observation endpoint. Observations are
used by admins to discover candidate agents for delegation.

Errors are logged to stderr (prefix KORA_SCAN_WARN), never raised.
"""
from __future__ import annotations

import os
import socket
import sys
import time
from datetime import datetime, timezone
from typing import Any

import requests


_DEFAULT_BASE_URL = "https://api.koraprotocol.com"


class KoraAuto:
    """Scan-mode SDK — observe spend intent, never sign or enforce.

    Args:
        scan_token: Scan token issued by admin via POST /v1/auto/tokens
        base_url: Kora API base URL
    """

    def __init__(self, scan_token: str, base_url: str = _DEFAULT_BASE_URL):
        self._scan_token = scan_token
        self._base_url = base_url.rstrip("/")
        # Throttle: track (vendor, error_reason) → last_warn_time
        self._warn_throttle: dict[tuple[str, str], float] = {}

    def observe(
        self,
        vendor: str,
        amount_cents: int | None = None,
        currency: str | None = None,
        reason: str | None = None,
        service_name: str | None = None,
        environment: str | None = None,
        runtime_id: str | None = None,
        repo_hint: str | None = None,
    ) -> dict:
        """Emit a spend observation to Kora.

        Auto-detects runtime fields from environment variables if not provided:
        - service_name: KORA_SERVICE_NAME or hostname
        - environment: KORA_ENVIRONMENT or "unknown"
        - runtime_id: KORA_RUNTIME_ID or "unknown"

        Returns {"status": "ok"} on success.
        On failure: logs KORA_SCAN_WARN to stderr, does NOT raise.
        """
        svc = service_name or os.environ.get("KORA_SERVICE_NAME") or socket.gethostname()
        env = environment or os.environ.get("KORA_ENVIRONMENT") or "unknown"
        rt_id = runtime_id or os.environ.get("KORA_RUNTIME_ID") or "unknown"

        body: dict[str, Any] = {
            "signal_type": "EXPLICIT_SPEND_INTENT",
            "observed_at": datetime.now(timezone.utc).isoformat(),
            "runtime": {
                "service_name": svc,
                "environment": env,
                "runtime_id": rt_id,
            },
            "spend": {
                "vendor_id": vendor,
            },
        }

        if repo_hint is not None:
            body["runtime"]["repo_hint"] = repo_hint
        if amount_cents is not None:
            body["spend"]["amount_cents"] = amount_cents
        if currency is not None:
            body["spend"]["currency"] = currency
        if reason is not None:
            body["spend"]["reason"] = reason

        try:
            resp = requests.post(
                f"{self._base_url}/v1/auto/observe",
                json=body,
                headers={"X-Scan-Token": self._scan_token},
                timeout=5,
            )
            if resp.status_code >= 400:
                error_reason = f"http_{resp.status_code}"
                self._warn(vendor, svc, env, rt_id, error_reason)
                return {"status": "error"}
            return resp.json()
        except Exception as exc:
            error_reason = type(exc).__name__.lower()
            self._warn(vendor, svc, env, rt_id, error_reason)
            return {"status": "error"}

    def _warn(self, vendor: str, service: str, env: str,
              runtime_id: str, error: str) -> None:
        """Emit KORA_SCAN_WARN to stderr, throttled to once per 60s per (vendor, error)."""
        key = (vendor, error)
        now = time.monotonic()
        last = self._warn_throttle.get(key, 0.0)
        if now - last < 60.0:
            return
        self._warn_throttle[key] = now

        print(
            f"KORA_SCAN_WARN vendor={vendor} service={service} "
            f"env={env} runtime={runtime_id} error={error}",
            file=sys.stderr,
        )
