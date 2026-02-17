import { describe, it, expect } from 'vitest';
import { parseResponse, Kora } from '../src/client.js';
import type { RawApiResponse } from '../src/types.js';

describe('parseResponse', () => {
  it('parses APPROVED response correctly', () => {
    const raw: RawApiResponse = {
      decision_id: 'dec-123',
      intent_id: 'int-456',
      decision: 'APPROVED',
      reason_code: 'OK',
      agent_id: 'agent_001',
      mandate_id: 'mand-789',
      mandate_version: 1,
      amount_cents: 5000,
      currency: 'EUR',
      vendor_id: 'aws',
      evaluated_at: '2026-02-10T08:00:00+00:00',
      expires_at: '2099-12-31T23:59:59+00:00',
      ttl_seconds: 300,
      notary_seal: {
        signature: 'sig123',
        public_key_id: 'kora_prod_key_v1',
        algorithm: 'Ed25519',
        signed_fields: ['intent_id', 'status'],
        timestamp: '2026-02-10T08:00:00+00:00',
      },
      limits_after_approval: {
        daily_remaining_cents: 95000,
        monthly_remaining_cents: 495000,
        daily_limit_cents: 100000,
        monthly_limit_cents: 500000,
      },
      executable: true,
      enforcement_mode: 'enforce',
    };

    const result = parseResponse(raw);

    expect(result.decisionId).toBe('dec-123');
    expect(result.intentId).toBe('int-456');
    expect(result.decision).toBe('APPROVED');
    expect(result.reasonCode).toBe('OK');
    expect(result.approved).toBe(true);
    expect(result.executable).toBe(true);
    expect(result.isEnforced).toBe(true);
    expect(result.isValid).toBe(true); // expires in 2099
    expect(result.notarySeal).not.toBeNull();
    expect(result.notarySeal?.publicKeyId).toBe('kora_prod_key_v1');
    expect(result.limitsAfterApproval?.dailyRemainingCents).toBe(95000);
  });

  it('parses DENIED response correctly', () => {
    const raw: RawApiResponse = {
      decision_id: 'dec-denied',
      intent_id: 'int-denied',
      decision: 'DENIED',
      reason_code: 'DAILY_LIMIT_EXCEEDED',
      agent_id: 'agent_001',
      mandate_id: 'mand-789',
      mandate_version: 1,
      evaluated_at: '2026-02-10T08:00:00+00:00',
      limits_current: {
        daily_spent_cents: 90000,
        monthly_spent_cents: 200000,
        daily_limit_cents: 100000,
        monthly_limit_cents: 500000,
      },
      denial: {
        reason_code: 'DAILY_LIMIT_EXCEEDED',
        message: 'Daily limit exceeded',
        hint: 'Reduce amount or wait',
        actionable: { available_cents: 10000 },
      },
    };

    const result = parseResponse(raw);

    expect(result.decision).toBe('DENIED');
    expect(result.approved).toBe(false);
    expect(result.denial).not.toBeNull();
    expect(result.denial?.reasonCode).toBe('DAILY_LIMIT_EXCEEDED');
    expect(result.denial?.message).toBe('Daily limit exceeded');
    expect(result.denial?.actionable.available_cents).toBe(10000);
    expect(result.limitsCurrent?.dailySpentCents).toBe(90000);
    expect(result.notarySeal).toBeNull();
  });

  it('sets isValid to false for expired TTL', () => {
    const raw: RawApiResponse = {
      decision: 'APPROVED',
      reason_code: 'OK',
      evaluated_at: '2020-01-01T00:00:00+00:00',
      expires_at: '2020-01-01T00:05:00+00:00', // In the past
      executable: true,
    };

    const result = parseResponse(raw);
    expect(result.isValid).toBe(false);
  });

  it('sets isEnforced correctly for log_only mode', () => {
    const raw: RawApiResponse = {
      decision: 'APPROVED',
      reason_code: 'OK',
      evaluated_at: '2026-02-10T08:00:00+00:00',
      enforcement_mode: 'log_only',
      executable: false,
    };

    const result = parseResponse(raw);
    expect(result.isEnforced).toBe(false);
    expect(result.executable).toBe(false);
  });

  it('handles simulated response', () => {
    const raw: RawApiResponse = {
      decision: 'DENIED',
      reason_code: 'VENDOR_NOT_ALLOWED',
      evaluated_at: '2026-02-10T08:00:00+00:00',
      simulated: true,
      notary_seal: null,
      executable: false,
    };

    const result = parseResponse(raw);
    expect(result.simulated).toBe(true);
    expect(result.notarySeal).toBeNull();
    expect(result.executable).toBe(false);
  });

  it('parses evaluation trace', () => {
    const raw: RawApiResponse = {
      decision: 'APPROVED',
      reason_code: 'OK',
      evaluated_at: '2026-02-10T08:00:00+00:00',
      evaluation_trace: {
        steps: [
          { step: 0, check: 'rate_limit', result: 'PASS', duration_ms: 1 },
          { step: 1, check: 'validate', result: 'PASS', duration_ms: 0 },
        ],
        total_duration_ms: 5,
      },
    };

    const result = parseResponse(raw);
    expect(result.evaluationTrace).not.toBeNull();
    expect(result.evaluationTrace?.steps.length).toBe(2);
    expect(result.evaluationTrace?.steps[0].check).toBe('rate_limit');
    expect(result.evaluationTrace?.totalDurationMs).toBe(5);
  });
});

describe('Kora.asTool', () => {
  // We can't easily construct a Kora instance without a real key,
  // so we test asTool via a helper that mimics the construction.
  it('returns valid OpenAI function schema', () => {
    // Build a minimal valid key for construction
    const nacl = require('tweetnacl');
    const kp = nacl.sign.keyPair();
    const seed = kp.secretKey.slice(0, 32);
    const hex = Buffer.from(seed).toString('hex');
    const raw = `test_agent:${hex}`;
    const encoded = Buffer.from(raw).toString('base64');
    const keyString = `kora_agent_sk_${encoded}`;

    const kora = new Kora(keyString);
    const tool = kora.asTool('mandate_abc123');

    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('kora_authorize_spend');
    expect(tool.function.parameters).toBeDefined();
    const params = tool.function.parameters as Record<string, unknown>;
    expect(params.type).toBe('object');
    expect(params.required).toEqual(['amount_cents', 'currency', 'vendor_id']);
  });

  it('includes category enum when provided', () => {
    const nacl = require('tweetnacl');
    const kp = nacl.sign.keyPair();
    const seed = kp.secretKey.slice(0, 32);
    const hex = Buffer.from(seed).toString('hex');
    const raw = `test_agent:${hex}`;
    const encoded = Buffer.from(raw).toString('base64');
    const keyString = `kora_agent_sk_${encoded}`;

    const kora = new Kora(keyString);
    const tool = kora.asTool('mandate_abc123', ['compute', 'api_services']);

    const params = tool.function.parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, Record<string, unknown>>;
    expect(properties.category.enum).toEqual(['compute', 'api_services']);
  });
});
