/**
 * Unit tests for the simplified Kora SDK (simple.ts).
 *
 * Tests SpendResult/BudgetResult construction, formatAmount, denial logging,
 * and package exports. Does NOT test live API calls (see e2e.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatAmount } from '../src/format.js';
import { Kora, buildSpendResult, type SpendResult, type BudgetResult, type KoraConfig } from '../src/simple.js';
import { Kora as KoraEngine } from '../src/client.js';
import type { AuthorizationResult } from '../src/types.js';

// ---------------------------------------------------------------------------
// formatAmount tests (spec A.4.1)
// ---------------------------------------------------------------------------

describe('formatAmount', () => {
  it('EUR → €50.00', () => {
    expect(formatAmount(5000, 'EUR')).toBe('€50.00');
  });

  it('USD → $1.50', () => {
    expect(formatAmount(150, 'USD')).toBe('$1.50');
  });

  it('GBP → £99.99', () => {
    expect(formatAmount(9999, 'GBP')).toBe('£99.99');
  });

  it('SEK → kr10000.00', () => {
    expect(formatAmount(1000000, 'SEK')).toBe('kr10000.00');
  });

  it('zero → €0.00', () => {
    expect(formatAmount(0, 'EUR')).toBe('€0.00');
  });

  it('unknown currency → code prefix', () => {
    expect(formatAmount(5000, 'CHF')).toBe('CHF 50.00');
  });

  it('lowercase currency → still works', () => {
    expect(formatAmount(5000, 'eur')).toBe('€50.00');
  });
});

// ---------------------------------------------------------------------------
// Helper: build a mock Kora instance without hitting the network
// ---------------------------------------------------------------------------

function makeMockKora(
  engineReturnValue: AuthorizationResult,
  opts: { logDenials?: boolean } = {},
): Kora {
  // Create a real key so parseAgentKey doesn't throw
  const nacl = require('tweetnacl');
  const kp = nacl.sign.keyPair();
  const seed = kp.secretKey.slice(0, 32);
  const hex = Buffer.from(seed).toString('hex');
  const raw = `test_agent:${hex}`;
  const encoded = Buffer.from(raw).toString('base64');
  const keyString = `kora_agent_sk_${encoded}`;

  const kora = new Kora({
    secret: keyString,
    mandate: 'mandate_abc',
    baseUrl: 'http://localhost:8000',
    logDenials: opts.logDenials ?? false,
  });

  // Monkey-patch the internal engine's authorize method
  const engine = (kora as any).engine as KoraEngine;
  engine.authorize = vi.fn().mockResolvedValue(engineReturnValue);

  return kora;
}

function makeApprovedResult(): AuthorizationResult {
  return {
    decisionId: 'dec-123',
    intentId: 'int-456',
    decision: 'APPROVED',
    reasonCode: 'OK',
    agentId: 'agent_001',
    mandateId: 'mandate_abc',
    mandateVersion: 1,
    amountCents: 5000,
    currency: 'EUR',
    vendorId: 'aws',
    evaluatedAt: '2026-02-15T10:00:00+00:00',
    expiresAt: '2026-02-15T10:05:00+00:00',
    ttlSeconds: 300,
    notarySeal: {
      signature: 'sig',
      publicKeyId: 'k1',
      algorithm: 'Ed25519',
      signedFields: ['intent_id'],
      timestamp: '2026-02-15T10:00:00+00:00',
    },
    limitsAfterApproval: null,
    limitsCurrent: null,
    paymentInstruction: {
      recipientIban: 'DE89370400440532013000',
      recipientBic: 'COBADEFFXXX',
      recipientName: 'AWS Inc',
      paymentReference: undefined,
    },
    denial: null,
    evaluationTrace: null,
    traceUrl: '/v1/authorizations/dec-123/trace',
    executable: true,
    enforcementMode: 'enforce',
    simulated: false,
    approved: true,
    isValid: true,
    isEnforced: true,
  };
}

function makeDeniedResult(): AuthorizationResult {
  return {
    decisionId: 'dec-456',
    intentId: 'int-789',
    decision: 'DENIED',
    reasonCode: 'DAILY_LIMIT_EXCEEDED',
    agentId: 'agent_001',
    mandateId: 'mandate_abc',
    mandateVersion: 1,
    amountCents: 50000,
    currency: 'EUR',
    vendorId: 'aws',
    evaluatedAt: '2026-02-15T10:00:00+00:00',
    expiresAt: undefined,
    ttlSeconds: undefined,
    notarySeal: null,
    limitsAfterApproval: null,
    limitsCurrent: null,
    paymentInstruction: null,
    denial: {
      reasonCode: 'DAILY_LIMIT_EXCEEDED',
      message: 'Daily limit exceeded. Requested: 50000 cents, Available: 1200 cents.',
      hint: 'Reduce amount to 1200 or wait for daily reset.',
      actionable: { available_cents: 1200, next_reset_at: '2026-02-16T00:00:00+01:00' },
    },
    evaluationTrace: null,
    traceUrl: '/v1/authorizations/dec-456/trace',
    executable: false,
    enforcementMode: 'enforce',
    simulated: false,
    approved: false,
    isValid: true,
    isEnforced: true,
  };
}

// ---------------------------------------------------------------------------
// SpendResult message construction
// ---------------------------------------------------------------------------

describe('Kora.spend — result mapping', () => {
  it('APPROVED → message = "Approved: €50.00 to aws"', async () => {
    const kora = makeMockKora(makeApprovedResult());
    const r = await kora.spend('aws', 5000, 'EUR');
    expect(r.approved).toBe(true);
    expect(r.message).toBe('Approved: €50.00 to aws');
    expect(r.suggestion).toBeNull();
    expect(r.retryWith).toBeNull();
  });

  it('DENIED → message from denial.message', async () => {
    const kora = makeMockKora(makeDeniedResult());
    const r = await kora.spend('aws', 50000, 'EUR');
    expect(r.approved).toBe(false);
    expect(r.message).toContain('Daily limit exceeded');
  });

  it('DENIED → suggestion from denial.hint', async () => {
    const kora = makeMockKora(makeDeniedResult());
    const r = await kora.spend('aws', 50000, 'EUR');
    expect(r.suggestion).not.toBeNull();
    expect(r.suggestion).toContain('1200');
  });

  it('DENIED → retryWith from actionable.available_cents', async () => {
    const kora = makeMockKora(makeDeniedResult());
    const r = await kora.spend('aws', 50000, 'EUR');
    expect(r.retryWith).toEqual({ amount_cents: 1200 });
  });

  it('APPROVED → payment from paymentInstruction', async () => {
    const kora = makeMockKora(makeApprovedResult());
    const r = await kora.spend('aws', 5000, 'EUR');
    expect(r.payment).not.toBeNull();
    expect(r.payment!.iban).toBe('DE89370400440532013000');
    expect(r.payment!.bic).toBe('COBADEFFXXX');
    expect(r.payment!.name).toBe('AWS Inc');
  });

  it('APPROVED → seal is present', async () => {
    const kora = makeMockKora(makeApprovedResult());
    const r = await kora.spend('aws', 5000, 'EUR');
    expect(r.seal).not.toBeNull();
    expect((r.seal as any).algorithm).toBe('Ed25519');
  });

  it('passes reason as purpose', async () => {
    const result = makeApprovedResult();
    const kora = makeMockKora(result);
    await kora.spend('aws', 5000, 'EUR', 'GPU compute');
    const engine = (kora as any).engine as KoraEngine;
    const callArgs = (engine.authorize as any).mock.calls[0][0];
    expect(callArgs.purpose).toBe('GPU compute');
  });
});

// ---------------------------------------------------------------------------
// Stderr denial logging
// ---------------------------------------------------------------------------

describe('Kora.spend — denial logging', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('DENIED with logDenials=true → emits KORA_DENIAL to stderr', async () => {
    const kora = makeMockKora(makeDeniedResult(), { logDenials: true });
    await kora.spend('aws', 50000, 'EUR');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = stderrSpy.mock.calls[0][0] as string;
    expect(line).toContain('KORA_DENIAL');
    expect(line).toContain('agent=');
    expect(line).toContain('mandate=mandate_abc');
    expect(line).toContain('vendor=aws');
    expect(line).toContain('amount=50000');
    expect(line).toContain('currency=EUR');
    expect(line).toContain('reason=DAILY_LIMIT_EXCEEDED');
    expect(line).toContain('remaining_cents=1200');
    expect(line).toContain('trace=');
  });

  it('APPROVED → no stderr output', async () => {
    const kora = makeMockKora(makeApprovedResult(), { logDenials: true });
    await kora.spend('aws', 5000, 'EUR');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('logDenials=false → no stderr even on denial', async () => {
    const kora = makeMockKora(makeDeniedResult(), { logDenials: false });
    await kora.spend('aws', 50000, 'EUR');
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Package exports
// ---------------------------------------------------------------------------

describe('package exports', () => {
  it('Kora is the simplified class', async () => {
    const { Kora: ImportedKora } = await import('../src/index.js');
    const { Kora: SimpleKora } = await import('../src/simple.js');
    expect(ImportedKora).toBe(SimpleKora);
  });

  it('KoraEngine is the V1 class', async () => {
    const { KoraEngine: ImportedEngine } = await import('../src/index.js');
    const { Kora: V1Kora } = await import('../src/client.js');
    expect(ImportedEngine).toBe(V1Kora);
  });

  it('SpendResult type is exported (compile check)', async () => {
    const mod = await import('../src/index.js');
    // The type exists (this is a compile-time check — we just verify the module loads)
    expect(mod.Kora).toBeDefined();
  });

  it('formatAmount is exported and works', async () => {
    const { formatAmount: fa } = await import('../src/index.js');
    expect(fa(5000, 'EUR')).toBe('€50.00');
  });
});

// ---------------------------------------------------------------------------
// Response version compatibility (B.6.1)
// ---------------------------------------------------------------------------

describe('buildSpendResult — response version compat', () => {
  it('handles old response shape (has payment_instruction, no amount_cents at root)', () => {
    const oldResponse = {
      decision_id: 'a1b2c3d4',
      intent_id: 'e5f6a7b8',
      decision: 'APPROVED',
      reason_code: 'OK',
      mandate_id: 'mandate_abc',
      mandate_version: 1,
      evaluated_at: '2026-02-18T12:00:00.000Z',
      expires_at: '2026-02-18T12:05:00.000Z',
      ttl_seconds: 300,
      payment_instruction: {
        recipient_iban: 'DE89370400440532013000',
        recipient_name: 'AWS EMEA SARL',
        recipient_bic: 'COBADEFFXXX',
        reference: 'KORA-a1b2c3d4-MV1',
        amount_cents: 5000,
        currency: 'EUR',
      },
      executable: true,
      notary_seal: { algorithm: 'Ed25519', signature: 'abc123' },
      limits_after_approval: {
        daily_remaining_cents: 95000,
        monthly_remaining_cents: 495000,
      },
    };
    const result = buildSpendResult(oldResponse);
    expect(result.approved).toBe(true);
    expect(result.decisionId).toBe('a1b2c3d4');
    expect(result.decision).toBe('APPROVED');
    expect(result.reasonCode).toBe('OK');
    expect(result.payment).not.toBeNull();
    expect(result.payment!.iban).toBe('DE89370400440532013000');
    expect(result.payment!.bic).toBe('COBADEFFXXX');
    expect(result.payment!.name).toBe('AWS EMEA SARL');
    expect(result.payment!.reference).toBe('KORA-a1b2c3d4-MV1');
    expect(result.executable).toBe(true);
    expect(result.seal).not.toBeNull();
    expect((result.seal as any).algorithm).toBe('Ed25519');
    expect(result.raw).toBe(oldResponse);
  });

  it('handles future response shape (no payment_instruction, has enforcement_mode)', () => {
    const futureResponse = {
      decision_id: 'a1b2c3d4',
      intent_id: 'e5f6a7b8',
      decision: 'APPROVED',
      reason_code: 'OK',
      mandate_id: 'mandate_abc',
      mandate_version: 1,
      amount_cents: 5000,
      currency: 'EUR',
      vendor_id: 'aws',
      enforcement_mode: 'enforce',
      evaluated_at: '2026-02-18T12:00:00.000Z',
      expires_at: '2026-02-18T12:05:00.000Z',
      ttl_seconds: 300,
      notary_seal: { algorithm: 'Ed25519', signature: 'abc123' },
      limits_after_approval: {
        daily_remaining_cents: 95000,
        monthly_remaining_cents: 495000,
      },
    };
    const result = buildSpendResult(futureResponse);
    expect(result.approved).toBe(true);
    expect(result.decisionId).toBe('a1b2c3d4');
    expect(result.payment).toBeNull();
    expect(result.executable).toBe(true);
    expect(result.seal).not.toBeNull();
    expect(result.raw).toBe(futureResponse);
  });

  it('denied response with denial sub-object extracts message/suggestion/retryWith', () => {
    const deniedResponse = {
      decision_id: 'dec-999',
      decision: 'DENIED',
      reason_code: 'DAILY_LIMIT_EXCEEDED',
      denial: {
        message: 'Daily limit exceeded.',
        hint: 'Reduce amount to 1200.',
        actionable: { available_cents: 1200 },
      },
      executable: false,
    };
    const result = buildSpendResult(deniedResponse);
    expect(result.approved).toBe(false);
    expect(result.message).toBe('Daily limit exceeded.');
    expect(result.suggestion).toBe('Reduce amount to 1200.');
    expect(result.retryWith).toEqual({ amount_cents: 1200 });
    expect(result.payment).toBeNull();
    expect(result.seal).toBeNull();
    expect(result.executable).toBe(false);
  });

  it('missing executable field defaults to true (forward-compat)', () => {
    const response = {
      decision_id: 'dec-100',
      decision: 'APPROVED',
      reason_code: 'OK',
    };
    const result = buildSpendResult(response);
    expect(result.executable).toBe(true);
  });
});
