"""Cryptographic utilities for the Kora SDK.

Handles agent key parsing, canonical JSON, Ed25519 signing, and seal verification.
Uses PyNaCl (same library as the Kora server) for Ed25519.
"""
from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey


AGENT_SK_PREFIX = "kora_agent_sk_"


def parse_agent_key(key_string: str) -> tuple[str, SigningKey]:
    """Parse a Kora agent secret key string.

    Format: kora_agent_sk_<base64(agent_id:private_key_hex)>

    Returns:
        (agent_id, signing_key)

    Raises:
        ValueError: If the key string is malformed.
    """
    if not key_string.startswith(AGENT_SK_PREFIX):
        raise ValueError(f"Agent key must start with '{AGENT_SK_PREFIX}'")

    encoded = key_string[len(AGENT_SK_PREFIX):]
    try:
        decoded = base64.b64decode(encoded).decode("utf-8")
    except Exception as exc:
        raise ValueError(f"Invalid base64 in agent key: {exc}") from exc

    if ":" not in decoded:
        raise ValueError("Agent key payload missing ':' separator")

    agent_id, private_hex = decoded.split(":", 1)

    if not agent_id:
        raise ValueError("Agent key has empty agent_id")

    try:
        seed = bytes.fromhex(private_hex)
    except ValueError as exc:
        raise ValueError(f"Invalid hex in private key: {exc}") from exc

    if len(seed) != 32:
        raise ValueError(
            f"Private key must be 32 bytes, got {len(seed)}"
        )

    signing_key = SigningKey(seed)
    return agent_id, signing_key


def sort_keys_deep(obj: Any) -> Any:
    """Recursively sort dictionary keys for deterministic serialization."""
    if isinstance(obj, dict):
        return {k: sort_keys_deep(v) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        return [sort_keys_deep(item) for item in obj]
    return obj


def canonicalize(obj: dict[str, Any]) -> bytes:
    """Produce canonical JSON bytes (sorted keys, compact separators).

    Matches the server's canonicalize_json() exactly:
    json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    """
    sorted_obj = sort_keys_deep(obj)
    return json.dumps(sorted_obj, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def sign_message(message: bytes, signing_key: SigningKey) -> str:
    """Sign a message with Ed25519 and return base64 signature."""
    signed = signing_key.sign(message)
    return base64.b64encode(signed.signature).decode("ascii")


def verify_signature(
    message: bytes, signature_b64: str, public_key_b64: str
) -> bool:
    """Verify an Ed25519 signature against a message."""
    try:
        public_key_bytes = base64.b64decode(public_key_b64)
        verify_key = VerifyKey(public_key_bytes)
        signature = base64.b64decode(signature_b64)
        verify_key.verify(message, signature)
        return True
    except (BadSignatureError, Exception):
        return False


def verify_seal(
    decision_payload: dict[str, Any],
    signature_b64: str,
    public_key_b64: str,
) -> bool:
    """Verify a Kora notary seal.

    The server signs SHA-256(canonical_json(decision_payload)),
    so we must hash before verifying.
    """
    canonical = canonicalize(decision_payload)
    payload_hash = hashlib.sha256(canonical).digest()
    return verify_signature(payload_hash, signature_b64, public_key_b64)


def build_signed_fields(
    *,
    intent_id: str,
    agent_id: str,
    mandate_id: str,
    amount_cents: int,
    currency: str,
    vendor_id: str,
    nonce: str,
    ttl_seconds: int,
    payment_instruction: dict[str, str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the signed_fields dict matching the server's expected format."""
    fields: dict[str, Any] = {
        "intent_id": intent_id,
        "agent_id": agent_id,
        "mandate_id": mandate_id,
        "amount_cents": amount_cents,
        "currency": currency,
        "vendor_id": vendor_id,
        "nonce": nonce,
        "ttl_seconds": ttl_seconds,
    }
    if payment_instruction:
        fields["payment_instruction"] = payment_instruction
    if metadata:
        fields["metadata"] = metadata
    return fields
