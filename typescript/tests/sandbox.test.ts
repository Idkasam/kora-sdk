/**
 * Tests for Kora SDK sandbox mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Kora } from '../src/simple.js';

// --- Constructor tests ---

describe('sandbox — constructor', () => {
  it('Kora({ sandbox: true }) works without secret or mandate', () => {
    const kora = new Kora({ sandbox: true });
    expect((kora as any)._sandbox).toBe(true);
  });

  it('production requires secret', () => {
    expect(() => new Kora()).toThrow('secret is required');
  });

  it('production requires mandate', () => {
    expect(() => new Kora({ secret: 'kora_agent_sk_fake' })).toThrow('mandate is required');
  });
});

// --- spend() approved ---

describe('sandbox — spend approved', () => {
  it('basic approved spend returns correct SpendResult', async () => {
    const kora = new Kora({ sandbox: true });
    const result = await kora.spend('aws', 5000, 'EUR');
    expect(result.approved).toBe(true);
    expect(result.decision).toBe('APPROVED');
    expect(result.reasonCode).toBe('OK');
    expect(result.enforcementMode).toBe('enforce');
    expect(result.amountCents).toBe(5000);
    expect(result.currency).toBe('EUR');
    expect(result.vendorId).toBe('aws');
    expect(result.seal).not.toBeNull();
    expect(result.suggestion).toBeNull();
    expect(result.retryWith).toBeNull();
  });

  it('decision IDs start with sandbox_', async () => {
    const kora = new Kora({ sandbox: true });
    const result = await kora.spend('aws', 5000, 'EUR');
    expect(result.decisionId).toMatch(/^sandbox_/);
  });

  it('seal has sandbox identifiers', async () => {
    const kora = new Kora({ sandbox: true });
    const result = await kora.spend('aws', 5000, 'EUR');
    expect((result.seal as any).signature).toMatch(/sandbox_sig_/);
    expect((result.seal as any).public_key_id).toBe('sandbox_key_v1');
  });

  it('multiple spends accumulate daily counter', async () => {
    const kora = new Kora({ sandbox: true });
    await kora.spend('aws', 500000, 'EUR');  // 5,000
    await kora.spend('aws', 300000, 'EUR');  // 3,000
    const budget = await kora.checkBudget();
    expect(budget.daily.spentCents).toBe(800000);
    expect(budget.daily.remainingCents).toBe(200000);
  });

  it('all vendors return enforcementMode and correct vendorId', async () => {
    const kora = new Kora({ sandbox: true });
    const r1 = await kora.spend('aws', 1000, 'EUR');
    const r2 = await kora.spend('stripe', 1000, 'EUR');
    const r3 = await kora.spend('random_vendor', 1000, 'EUR');
    expect(r1.enforcementMode).toBe('enforce');
    expect(r2.enforcementMode).toBe('enforce');
    expect(r3.enforcementMode).toBe('enforce');
    expect(r1.vendorId).toBe('aws');
    expect(r2.vendorId).toBe('stripe');
    expect(r3.vendorId).toBe('random_vendor');
  });
});

// --- spend() denied ---

describe('sandbox — spend denied', () => {
  it('exceeding daily limit returns DENIED', async () => {
    const kora = new Kora({ sandbox: true });
    await kora.spend('aws', 900000, 'EUR');  // 9,000 — approved
    const result = await kora.spend('aws', 200000, 'EUR');  // 2,000 — exceeds 10k daily
    expect(result.approved).toBe(false);
    expect(result.decision).toBe('DENIED');
    expect(result.reasonCode).toBe('DAILY_LIMIT_EXCEEDED');
    expect(result.enforcementMode).toBe('enforce');
    expect(result.seal).toBeNull();
    expect(result.suggestion).not.toBeNull();
  });

  it('DAILY_LIMIT_EXCEEDED includes retryWith with remaining amount', async () => {
    const kora = new Kora({ sandbox: true });
    await kora.spend('aws', 900000, 'EUR');  // 9,000
    const result = await kora.spend('aws', 200000, 'EUR');  // try 2,000, only 1,000 left
    expect(result.retryWith).not.toBeNull();
    expect(result.retryWith!.amount_cents).toBe(100000);  // 1,000
  });

  it('exceeding monthly limit returns DENIED', async () => {
    const kora = new Kora({ sandbox: true, sandboxConfig: { monthlyLimitCents: 100000 } });
    await kora.spend('aws', 80000, 'EUR');
    const result = await kora.spend('aws', 30000, 'EUR');
    expect(result.reasonCode).toBe('MONTHLY_LIMIT_EXCEEDED');
  });

  it('exceeding per-transaction limit returns DENIED', async () => {
    const kora = new Kora({ sandbox: true, sandboxConfig: { perTransactionMaxCents: 50000 } });
    const result = await kora.spend('aws', 60000, 'EUR');
    expect(result.reasonCode).toBe('PER_TRANSACTION_LIMIT_EXCEEDED');
    expect(result.retryWith!.amount_cents).toBe(50000);
  });

  it('vendor not in allowlist returns DENIED', async () => {
    const kora = new Kora({ sandbox: true, sandboxConfig: { allowedVendors: ['aws', 'gcp'] } });
    const result = await kora.spend('stripe', 5000, 'EUR');
    expect(result.reasonCode).toBe('VENDOR_NOT_ALLOWED');
    expect(result.retryWith).toBeNull();
  });

  it('wrong currency returns DENIED', async () => {
    const kora = new Kora({ sandbox: true });
    const result = await kora.spend('aws', 5000, 'USD');
    expect(result.reasonCode).toBe('CURRENCY_MISMATCH');
  });

  it('denied spend does NOT increment counters', async () => {
    const kora = new Kora({ sandbox: true, sandboxConfig: { perTransactionMaxCents: 1000 } });
    await kora.spend('aws', 5000, 'EUR');  // denied: per-tx limit
    const budget = await kora.checkBudget();
    expect(budget.daily.spentCents).toBe(0);
  });
});

// --- checkBudget() ---

describe('sandbox — checkBudget', () => {
  it('fresh sandbox has full budget available', async () => {
    const kora = new Kora({ sandbox: true });
    const budget = await kora.checkBudget();
    expect(budget.currency).toBe('EUR');
    expect(budget.status).toBe('active');
    expect(budget.spendAllowed).toBe(true);
    expect(budget.daily.limitCents).toBe(1000000);
    expect(budget.daily.spentCents).toBe(0);
    expect(budget.daily.remainingCents).toBe(1000000);
  });

  it('budget reflects spent amounts', async () => {
    const kora = new Kora({ sandbox: true });
    await kora.spend('aws', 250000, 'EUR');
    const budget = await kora.checkBudget();
    expect(budget.daily.spentCents).toBe(250000);
    expect(budget.daily.remainingCents).toBe(750000);
  });

  it('custom sandboxConfig is reflected in budget', async () => {
    const kora = new Kora({ sandbox: true, sandboxConfig: {
      dailyLimitCents: 500000,
      currency: 'USD',
      allowedVendors: ['aws'],
    }});
    const budget = await kora.checkBudget();
    expect(budget.daily.limitCents).toBe(500000);
    expect(budget.currency).toBe('USD');
    expect(budget.allowedVendors).toEqual(['aws']);
  });
});

// --- Input validation ---

describe('sandbox — input validation', () => {
  it('negative amount throws', async () => {
    const kora = new Kora({ sandbox: true });
    await expect(kora.spend('aws', -100, 'EUR')).rejects.toThrow('amount_cents');
  });

  it('zero amount throws', async () => {
    const kora = new Kora({ sandbox: true });
    await expect(kora.spend('aws', 0, 'EUR')).rejects.toThrow('amount_cents');
  });

  it('float amount throws', async () => {
    const kora = new Kora({ sandbox: true });
    await expect(kora.spend('aws', 50.5, 'EUR')).rejects.toThrow('amount_cents');
  });

  it('empty vendor throws', async () => {
    const kora = new Kora({ sandbox: true });
    await expect(kora.spend('', 5000, 'EUR')).rejects.toThrow('vendor');
  });

  it('invalid currency format throws', async () => {
    const kora = new Kora({ sandbox: true });
    await expect(kora.spend('aws', 5000, 'EURO')).rejects.toThrow('currency');
  });

  it('lowercase currency is normalized to uppercase', async () => {
    const kora = new Kora({ sandbox: true });
    const result = await kora.spend('aws', 5000, 'eur');
    expect(result.approved).toBe(true);
  });

  it('uppercase vendor is normalized to lowercase', async () => {
    const kora = new Kora({ sandbox: true });
    const result = await kora.spend('AWS', 5000, 'EUR');
    expect(result.approved).toBe(true);
  });
});

// --- Environment variable activation ---

describe('sandbox — env var activation', () => {
  const originalEnv = process.env.KORA_SANDBOX;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.KORA_SANDBOX;
    } else {
      process.env.KORA_SANDBOX = originalEnv;
    }
  });

  it('KORA_SANDBOX=true activates sandbox mode', async () => {
    process.env.KORA_SANDBOX = 'true';
    const kora = new Kora();  // no secret, no mandate — should not throw
    const result = await kora.spend('aws', 5000, 'EUR');
    expect(result.approved).toBe(true);
    expect(result.decisionId).toMatch(/^sandbox_/);
  });

  it('KORA_SANDBOX=1 also activates sandbox mode', () => {
    process.env.KORA_SANDBOX = '1';
    const kora = new Kora();
    expect((kora as any)._sandbox).toBe(true);
  });
});

// --- Stderr warning ---

describe('sandbox — stderr warning', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('stderr warning emitted exactly once', async () => {
    const kora = new Kora({ sandbox: true });
    await kora.spend('aws', 1000, 'EUR');
    await kora.spend('aws', 1000, 'EUR');
    await kora.spend('aws', 1000, 'EUR');
    const sandboxCalls = stderrSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('[KORA SANDBOX]'),
    );
    expect(sandboxCalls.length).toBe(1);
  });
});

// --- sandboxReset() ---

describe('sandbox — sandboxReset', () => {
  it('sandboxReset() clears all counters', async () => {
    const kora = new Kora({ sandbox: true });
    await kora.spend('aws', 500000, 'EUR');
    kora.sandboxReset();
    const budget = await kora.checkBudget();
    expect(budget.daily.spentCents).toBe(0);
    expect(budget.monthly.spentCents).toBe(0);
  });

  it('sandboxReset() throws in production mode', () => {
    // Create a bare Kora instance bypassing constructor
    const kora = Object.create(Kora.prototype);
    (kora as any)._sandbox = false;
    expect(() => kora.sandboxReset()).toThrow('sandboxReset');
  });
});

// --- Self-correcting agent pattern ---

describe('sandbox — self-correcting agent loop', () => {
  it('spend → denied → check budget → retry → approved', async () => {
    const kora = new Kora({ sandbox: true });

    // Spend most of the budget
    const r1 = await kora.spend('aws', 800000, 'EUR');
    expect(r1.approved).toBe(true);

    // Try to overspend
    const r2 = await kora.spend('aws', 500000, 'EUR');
    expect(r2.approved).toBe(false);
    expect(r2.retryWith).not.toBeNull();

    // Self-correct with suggested amount
    const r3 = await kora.spend('aws', r2.retryWith!.amount_cents, 'EUR');
    expect(r3.approved).toBe(true);

    // Now fully spent
    const r4 = await kora.spend('aws', 100, 'EUR');
    expect(r4.approved).toBe(false);
  });
});

// --- raw field ---

describe('sandbox — raw field', () => {
  it('raw contains sandbox: true', async () => {
    const kora = new Kora({ sandbox: true });
    const result = await kora.spend('aws', 5000, 'EUR');
    expect((result.raw as any).sandbox).toBe(true);
  });
});

// --- Existing exports unchanged ---

describe('sandbox — exports unchanged', () => {
  it('Kora and KoraEngine are both still exported', async () => {
    const mod = await import('../src/index.js');
    expect(mod.Kora).toBeDefined();
    expect(mod.KoraEngine).toBeDefined();
  });
});
