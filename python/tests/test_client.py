"""Unit tests for kora.client module."""
import base64

from nacl.signing import SigningKey

from kora.client import parse_response, Kora


# --- parse_response ---


class TestParseResponse:
    def test_approved_response(self):
        raw = {
            "decision_id": "dec-123",
            "intent_id": "int-456",
            "decision": "APPROVED",
            "reason_code": "OK",
            "agent_id": "agent_001",
            "mandate_id": "mand-789",
            "mandate_version": 1,
            "amount_cents": 5000,
            "currency": "EUR",
            "vendor_id": "aws",
            "evaluated_at": "2026-02-10T08:00:00+00:00",
            "expires_at": "2099-12-31T23:59:59+00:00",
            "ttl_seconds": 300,
            "notary_seal": {
                "signature": "sig123",
                "public_key_id": "kora_prod_key_v1",
                "algorithm": "Ed25519",
                "signed_fields": ["intent_id", "status"],
                "timestamp": "2026-02-10T08:00:00+00:00",
            },
            "limits_after_approval": {
                "daily_remaining_cents": 95000,
                "monthly_remaining_cents": 495000,
                "daily_limit_cents": 100000,
                "monthly_limit_cents": 500000,
            },
            "executable": True,
            "enforcement_mode": "enforce",
        }

        result = parse_response(raw)

        assert result.decision_id == "dec-123"
        assert result.intent_id == "int-456"
        assert result.decision == "APPROVED"
        assert result.reason_code == "OK"
        assert result.approved is True
        assert result.executable is True
        assert result.is_enforced is True
        assert result.is_valid is True  # expires in 2099
        assert result.notary_seal is not None
        assert result.notary_seal.public_key_id == "kora_prod_key_v1"
        assert result.limits_after_approval is not None
        assert result.limits_after_approval.daily_remaining_cents == 95000

    def test_denied_response(self):
        raw = {
            "decision_id": "dec-denied",
            "intent_id": "int-denied",
            "decision": "DENIED",
            "reason_code": "DAILY_LIMIT_EXCEEDED",
            "agent_id": "agent_001",
            "mandate_id": "mand-789",
            "mandate_version": 1,
            "evaluated_at": "2026-02-10T08:00:00+00:00",
            "limits_current": {
                "daily_spent_cents": 90000,
                "monthly_spent_cents": 200000,
                "daily_limit_cents": 100000,
                "monthly_limit_cents": 500000,
            },
            "denial": {
                "reason_code": "DAILY_LIMIT_EXCEEDED",
                "message": "Daily limit exceeded",
                "hint": "Reduce amount or wait",
                "actionable": {"available_cents": 10000},
            },
        }

        result = parse_response(raw)

        assert result.decision == "DENIED"
        assert result.approved is False
        assert result.denial is not None
        assert result.denial.reason_code == "DAILY_LIMIT_EXCEEDED"
        assert result.denial.message == "Daily limit exceeded"
        assert result.denial.actionable["available_cents"] == 10000
        assert result.limits_current is not None
        assert result.limits_current.daily_spent_cents == 90000
        assert result.notary_seal is None

    def test_expired_ttl(self):
        raw = {
            "decision": "APPROVED",
            "reason_code": "OK",
            "evaluated_at": "2020-01-01T00:00:00+00:00",
            "expires_at": "2020-01-01T00:05:00+00:00",
            "executable": True,
        }

        result = parse_response(raw)
        assert result.is_valid is False

    def test_log_only_mode(self):
        raw = {
            "decision": "APPROVED",
            "reason_code": "OK",
            "evaluated_at": "2026-02-10T08:00:00+00:00",
            "enforcement_mode": "log_only",
            "executable": False,
        }

        result = parse_response(raw)
        assert result.is_enforced is False
        assert result.executable is False

    def test_simulated_response(self):
        raw = {
            "decision": "DENIED",
            "reason_code": "VENDOR_NOT_ALLOWED",
            "evaluated_at": "2026-02-10T08:00:00+00:00",
            "simulated": True,
            "notary_seal": None,
            "executable": False,
        }

        result = parse_response(raw)
        assert result.simulated is True
        assert result.notary_seal is None
        assert result.executable is False

    def test_evaluation_trace(self):
        raw = {
            "decision": "APPROVED",
            "reason_code": "OK",
            "evaluated_at": "2026-02-10T08:00:00+00:00",
            "evaluation_trace": {
                "steps": [
                    {"step": 0, "check": "rate_limit", "result": "PASS", "duration_ms": 1},
                    {"step": 1, "check": "validate", "result": "PASS", "duration_ms": 0},
                ],
                "total_duration_ms": 5,
            },
        }

        result = parse_response(raw)
        assert result.evaluation_trace is not None
        assert len(result.evaluation_trace.steps) == 2
        assert result.evaluation_trace.steps[0].check == "rate_limit"
        assert result.evaluation_trace.total_duration_ms == 5


# --- Kora.as_tool ---


def _make_kora():
    """Build a Kora instance with a fresh key."""
    kp = SigningKey.generate()
    seed = bytes(kp)[:32]
    private_hex = seed.hex()
    raw = f"test_agent:{private_hex}"
    encoded = base64.b64encode(raw.encode()).decode()
    key_string = f"kora_agent_sk_{encoded}"
    return Kora(key_string)


class TestAsTool:
    def test_returns_valid_schema(self):
        kora = _make_kora()
        tool = kora.as_tool("mandate_abc123")

        assert tool["type"] == "function"
        assert tool["function"]["name"] == "kora_authorize_spend"
        assert tool["function"]["parameters"]["type"] == "object"
        assert tool["function"]["parameters"]["required"] == [
            "amount_cents",
            "currency",
            "vendor_id",
        ]

    def test_includes_category_enum(self):
        kora = _make_kora()
        tool = kora.as_tool("mandate_abc123", category_enum=["compute", "api_services"])

        props = tool["function"]["parameters"]["properties"]
        assert props["category"]["enum"] == ["compute", "api_services"]
