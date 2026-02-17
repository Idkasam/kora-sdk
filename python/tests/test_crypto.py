"""Unit tests for kora.crypto module."""
import base64

from nacl.signing import SigningKey

from kora.crypto import (
    build_signed_fields,
    canonicalize,
    parse_agent_key,
    sign_message,
    sort_keys_deep,
    verify_seal,
    verify_signature,
)


def _build_test_agent_key(agent_id: str = "agent_test_001"):
    """Build a test agent key in the server's format."""
    kp = SigningKey.generate()
    seed = bytes(kp)[:32]
    private_hex = seed.hex()
    raw = f"{agent_id}:{private_hex}"
    encoded = base64.b64encode(raw.encode()).decode()
    return f"kora_agent_sk_{encoded}", kp


# --- parse_agent_key ---


class TestParseAgentKey:
    def test_parses_valid_key(self):
        key_str, _ = _build_test_agent_key("agent_test_001")
        agent_id, signing_key = parse_agent_key(key_str)
        assert agent_id == "agent_test_001"
        assert isinstance(signing_key, SigningKey)

    def test_throws_on_missing_prefix(self):
        try:
            parse_agent_key("invalid_key")
            assert False, "Should have raised"
        except ValueError as e:
            assert "must start with" in str(e)

    def test_throws_on_missing_colon(self):
        encoded = base64.b64encode(b"noColonHere").decode()
        try:
            parse_agent_key(f"kora_agent_sk_{encoded}")
            assert False, "Should have raised"
        except ValueError as e:
            assert "missing" in str(e).lower() or "separator" in str(e).lower()

    def test_throws_on_empty_agent_id(self):
        encoded = base64.b64encode(f":{'ab' * 32}".encode()).decode()
        try:
            parse_agent_key(f"kora_agent_sk_{encoded}")
            assert False, "Should have raised"
        except ValueError as e:
            assert "empty" in str(e).lower()

    def test_throws_on_invalid_key_length(self):
        short_hex = "aabb"  # Only 2 bytes, need 32
        encoded = base64.b64encode(f"agent:{short_hex}".encode()).decode()
        try:
            parse_agent_key(f"kora_agent_sk_{encoded}")
            assert False, "Should have raised"
        except ValueError as e:
            assert "32 bytes" in str(e)


# --- sort_keys_deep ---


class TestSortKeysDeep:
    def test_sorts_top_level_keys(self):
        result = sort_keys_deep({"z": 1, "a": 2, "m": 3})
        assert list(result.keys()) == ["a", "m", "z"]

    def test_sorts_nested_keys(self):
        result = sort_keys_deep({"b": {"z": 1, "a": 2}, "a": 1})
        assert list(result.keys()) == ["a", "b"]
        assert list(result["b"].keys()) == ["a", "z"]

    def test_preserves_arrays(self):
        result = sort_keys_deep({"arr": [3, 1, 2]})
        assert result["arr"] == [3, 1, 2]

    def test_sorts_keys_inside_array_elements(self):
        result = sort_keys_deep({"arr": [{"z": 1, "a": 2}]})
        assert list(result["arr"][0].keys()) == ["a", "z"]


# --- canonicalize ---


class TestCanonicalize:
    def test_compact_json_sorted_keys(self):
        result = canonicalize({"b": 2, "a": 1})
        assert result == b'{"a":1,"b":2}'

    def test_matches_python_server_output(self):
        result = canonicalize({
            "vendor_id": "aws",
            "amount_cents": 5000,
            "agent_id": "agent_test_001",
        })
        assert result == b'{"agent_id":"agent_test_001","amount_cents":5000,"vendor_id":"aws"}'

    def test_utf8(self):
        result = canonicalize({"name": "café"})
        assert result == "{'name':'café'}".replace("'", '"').encode("utf-8")


# --- sign + verify ---


class TestSignAndVerify:
    def test_roundtrip(self):
        key_str, kp = _build_test_agent_key("test_agent")
        _, signing_key = parse_agent_key(key_str)
        message = canonicalize({"hello": "world"})
        signature = sign_message(message, signing_key)
        public_key_b64 = base64.b64encode(
            bytes(kp.verify_key)
        ).decode()
        assert verify_signature(message, signature, public_key_b64)

    def test_rejects_tampered_message(self):
        key_str, kp = _build_test_agent_key("test_agent")
        _, signing_key = parse_agent_key(key_str)
        message = canonicalize({"hello": "world"})
        signature = sign_message(message, signing_key)
        tampered = canonicalize({"hello": "tampered"})
        public_key_b64 = base64.b64encode(
            bytes(kp.verify_key)
        ).decode()
        assert not verify_signature(tampered, signature, public_key_b64)

    def test_rejects_wrong_key(self):
        key_str, _ = _build_test_agent_key("test_agent")
        other_kp = SigningKey.generate()
        _, signing_key = parse_agent_key(key_str)
        message = canonicalize({"hello": "world"})
        signature = sign_message(message, signing_key)
        wrong_key_b64 = base64.b64encode(
            bytes(other_kp.verify_key)
        ).decode()
        assert not verify_signature(message, signature, wrong_key_b64)


# --- build_signed_fields ---


class TestBuildSignedFields:
    def test_basic_fields(self):
        fields = build_signed_fields(
            intent_id="11111111-2222-3333-4444-555555555555",
            agent_id="agent_test_001",
            mandate_id="7f3d2a1b-9c8e-4f5d-a6b7-c8d9e0f1a2b3",
            amount_cents=5000,
            currency="EUR",
            vendor_id="aws",
            nonce="test_nonce",
            ttl_seconds=300,
        )
        assert fields == {
            "intent_id": "11111111-2222-3333-4444-555555555555",
            "agent_id": "agent_test_001",
            "mandate_id": "7f3d2a1b-9c8e-4f5d-a6b7-c8d9e0f1a2b3",
            "amount_cents": 5000,
            "currency": "EUR",
            "vendor_id": "aws",
            "nonce": "test_nonce",
            "ttl_seconds": 300,
        }

    def test_includes_payment_instruction(self):
        fields = build_signed_fields(
            intent_id="id",
            agent_id="agent",
            mandate_id="mandate",
            amount_cents=100,
            currency="EUR",
            vendor_id="aws",
            nonce="nonce",
            ttl_seconds=300,
            payment_instruction={"recipient_iban": "DE89370400440532013000"},
        )
        assert fields["payment_instruction"] == {
            "recipient_iban": "DE89370400440532013000"
        }

    def test_omits_payment_instruction_when_none(self):
        fields = build_signed_fields(
            intent_id="id",
            agent_id="agent",
            mandate_id="mandate",
            amount_cents=100,
            currency="EUR",
            vendor_id="aws",
            nonce="nonce",
            ttl_seconds=300,
            payment_instruction=None,
        )
        assert "payment_instruction" not in fields

    def test_includes_metadata(self):
        fields = build_signed_fields(
            intent_id="id",
            agent_id="agent",
            mandate_id="mandate",
            amount_cents=100,
            currency="EUR",
            vendor_id="aws",
            nonce="nonce",
            ttl_seconds=300,
            metadata={"key": "value"},
        )
        assert fields["metadata"] == {"key": "value"}
