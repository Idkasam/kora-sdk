"""End-to-end tests for the Kora Python SDK against a running server.

Prerequisites:
  - Kora API running at http://localhost:8000
  - Bootstrap admin key 'kora_bootstrap_test_key' in the database
"""
import hashlib
import os

import pytest
import requests

from kora import Kora


BASE_URL = os.environ.get("TEST_BASE_URL", "http://localhost:8000")
ADMIN_KEY = os.environ.get("TEST_ADMIN_KEY", "kora_bootstrap_test_key")


def _mgmt_fetch(path, method="GET", body=None):
    """Call management API."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {ADMIN_KEY}",
    }
    resp = requests.request(
        method, f"{BASE_URL}{path}", json=body, headers=headers, timeout=10
    )
    return resp


@pytest.fixture(scope="module")
def e2e_setup():
    """Create a test agent, mandate, and simulation admin key."""
    import time

    agent_name = f"sdk_py_e2e_agent_{int(time.time())}"

    # Create agent
    resp = _mgmt_fetch("/v1/agents", method="POST", body={
        "agent_id": agent_name,
        "name": "Python SDK E2E Test Agent",
    })
    assert resp.status_code == 201, f"Failed to create agent: {resp.status_code} {resp.text}"
    agent_data = resp.json()
    secret_key = agent_data["secret_key"]
    agent_id = agent_data["agent_id"]

    # Create mandate
    resp = _mgmt_fetch("/v1/mandates", method="POST", body={
        "agent_id": agent_id,
        "currency": "EUR",
        "daily_limit_cents": 100000,
        "monthly_limit_cents": 500000,
        "vendor_allowlist": ["aws", "stripe", "openai"],
        "epoch_timezone": "UTC",
    })
    assert resp.status_code == 201, f"Failed to create mandate: {resp.status_code} {resp.text}"
    mandate_data = resp.json()
    mandate_id = mandate_data["id"]

    # Create admin key with simulation_access
    resp = _mgmt_fetch("/v1/admin/keys", method="POST", body={
        "name": "sdk_py_e2e_sim",
        "simulation_access": True,
    })
    assert resp.status_code == 201, f"Failed to create sim key: {resp.status_code} {resp.text}"
    sim_key_data = resp.json()
    admin_sim_key = sim_key_data["secret"]

    return {
        "secret_key": secret_key,
        "agent_id": agent_id,
        "mandate_id": mandate_id,
        "admin_sim_key": admin_sim_key,
    }


class TestKoraSDKE2E:
    def test_authorize_approved(self, e2e_setup):
        kora = Kora(e2e_setup["secret_key"], base_url=BASE_URL)
        result = kora.authorize(
            mandate=e2e_setup["mandate_id"],
            amount=5000,
            currency="EUR",
            vendor="aws",
        )

        assert result.approved is True
        assert result.decision == "APPROVED"
        assert result.reason_code == "OK"
        assert result.decision_id
        assert result.intent_id
        assert result.enforcement_mode == "enforce"
        assert result.notary_seal is not None

    def test_authorize_denied_daily_limit(self, e2e_setup):
        kora = Kora(e2e_setup["secret_key"], base_url=BASE_URL)
        result = kora.authorize(
            mandate=e2e_setup["mandate_id"],
            amount=999999,
            currency="EUR",
            vendor="aws",
        )

        assert result.approved is False
        assert result.decision == "DENIED"
        assert result.reason_code == "DAILY_LIMIT_EXCEEDED"

    def test_sequential_calls_succeed(self, e2e_setup):
        kora = Kora(e2e_setup["secret_key"], base_url=BASE_URL)
        result = kora.authorize(
            mandate=e2e_setup["mandate_id"],
            amount=100,
            currency="EUR",
            vendor="aws",
        )
        assert result.approved is True

    def test_trace_url_present(self, e2e_setup):
        kora = Kora(e2e_setup["secret_key"], base_url=BASE_URL)
        result = kora.authorize(
            mandate=e2e_setup["mandate_id"],
            amount=100,
            currency="EUR",
            vendor="aws",
        )

        assert result.trace_url
        assert "/v1/authorizations/" in result.trace_url
        assert "/trace" in result.trace_url

    def test_evaluation_trace_present(self, e2e_setup):
        kora = Kora(e2e_setup["secret_key"], base_url=BASE_URL)
        result = kora.authorize(
            mandate=e2e_setup["mandate_id"],
            amount=100,
            currency="EUR",
            vendor="aws",
        )

        assert result.evaluation_trace is not None
        assert len(result.evaluation_trace.steps) > 0
        assert result.evaluation_trace.total_duration_ms >= 0

    def test_simulation_mode(self, e2e_setup):
        kora = Kora(e2e_setup["secret_key"], base_url=BASE_URL)
        result = kora.authorize(
            mandate=e2e_setup["mandate_id"],
            amount=100,
            currency="EUR",
            vendor="aws",
            simulate="DAILY_LIMIT_EXCEEDED",
            admin_key=e2e_setup["admin_sim_key"],
        )

        assert result.simulated is True
        assert result.decision == "DENIED"
        assert result.reason_code == "DAILY_LIMIT_EXCEEDED"
        assert result.notary_seal is None
        assert result.enforcement_mode == "enforce"

    def test_as_tool_schema(self, e2e_setup):
        kora = Kora(e2e_setup["secret_key"], base_url=BASE_URL)
        tool = kora.as_tool(e2e_setup["mandate_id"])

        assert tool["type"] == "function"
        assert tool["function"]["name"] == "kora_authorize_spend"
        assert e2e_setup["mandate_id"] in tool["function"]["description"]
        assert tool["function"]["parameters"]["required"] == [
            "amount_cents",
            "currency",
            "vendor_id",
        ]
