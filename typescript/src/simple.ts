/**
 * Simplified Kora SDK — spend() and checkBudget() with two-method API.
 *
 * This is the recommended interface for most agent integrations.
 * For advanced use (verifySeal, asTool, simulation), use KoraEngine directly.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { Kora as KoraEngine } from './client.js';
import { parseAgentKey, canonicalize, sign } from './crypto.js';
import { KoraError } from './errors.js';
import { formatAmount } from './format.js';
import { SandboxEngine } from './sandbox.js';
import type { SandboxConfig } from './sandbox.js';
import type { AuthorizationResult } from './types.js';

const DEFAULT_BASE_URL = 'https://api.koraprotocol.com';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SpendResult {
  approved: boolean;
  decisionId: string;
  decision: 'APPROVED' | 'DENIED';
  reasonCode: string;
  message: string;
  suggestion: string | null;
  retryWith: { amount_cents: number } | null;
  seal: object | null;
  enforcementMode: string;
  amountCents: number | null;
  currency: string | null;
  vendorId: string | null;
  raw: object;
}

export interface BudgetResult {
  currency: string;
  status: string;
  spendAllowed: boolean;
  enforcementMode: 'enforce' | 'log_only';
  daily: {
    limitCents: number;
    spentCents: number;
    remainingCents: number;
    resetsAt: string;
  };
  monthly: {
    limitCents: number;
    spentCents: number;
    remainingCents: number;
    resetsAt: string;
  };
  perTransactionMaxCents: number | null;
  velocity: {
    windowMaxCents: number;
    windowSpentCents: number;
    windowRemainingCents: number;
    windowResetsInSeconds: number;
  } | null;
  allowedVendors: string[] | null;
  allowedCategories: string[] | null;
  timeWindow: {
    allowedDays: string[];
    allowedHoursLocal: { start: string; end: string };
    currentlyOpen: boolean;
    nextOpenAt: string | null;
  } | null;
  raw: object;
}

export interface KoraConfig {
  secret?: string;
  mandate?: string;
  baseUrl?: string;
  logDenials?: boolean;
  sandbox?: boolean;
  sandboxConfig?: SandboxConfig;
}

// ---------------------------------------------------------------------------
// Simplified Kora class
// ---------------------------------------------------------------------------

export class Kora {
  private readonly engine: KoraEngine | null;
  private readonly sandboxEngine: SandboxEngine | null;
  private readonly _sandbox: boolean;
  private readonly mandate: string;
  private readonly agentId: string;
  private readonly signingKey: Uint8Array | null;
  private readonly baseUrl: string;
  private readonly logDenials: boolean;

  constructor(config: KoraConfig = {}) {
    // Environment variable activation
    const sandbox = config.sandbox
      || (typeof process !== 'undefined'
        && ['true', '1'].includes((process.env.KORA_SANDBOX ?? '').toLowerCase()));

    this._sandbox = sandbox;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.logDenials = config.logDenials ?? true;

    if (sandbox) {
      this.engine = null;
      this.sandboxEngine = new SandboxEngine(config.sandboxConfig);
      this.mandate = 'sandbox_mandate';
      this.agentId = 'sandbox_agent';
      this.signingKey = null;
    } else {
      if (!config.secret) {
        throw new Error('secret is required when sandbox is not enabled');
      }
      if (!config.mandate) {
        throw new Error('mandate is required when sandbox is not enabled');
      }
      this.engine = new KoraEngine(config.secret, { baseUrl: this.baseUrl });
      this.sandboxEngine = null;
      this.mandate = config.mandate;
      const parsed = parseAgentKey(config.secret);
      this.agentId = parsed.agentId;
      this.signingKey = parsed.signingKey;
    }
  }

  /**
   * Request authorization to spend.
   * Signs and submits to /v1/authorize.
   */
  async spend(
    vendor: string,
    amountCents: number,
    currency: string,
    reason?: string,
  ): Promise<SpendResult> {
    if (this._sandbox) {
      const raw = this.sandboxEngine!.spend(vendor, amountCents, currency, reason);
      const spendResult = buildSpendResult(raw);
      if (!spendResult.approved && this.logDenials) {
        this.logDenialSimple(spendResult, vendor, amountCents, currency);
      }
      return spendResult;
    }

    const params: Record<string, unknown> = {
      mandate: this.mandate,
      amount: amountCents,
      currency,
      vendor,
    };
    if (reason !== undefined) {
      (params as Record<string, unknown>).purpose = reason;
    }

    const result: AuthorizationResult = await this.engine!.authorize(
      params as any,
    );

    // Build SpendResult
    const approved = result.decision === 'APPROVED';

    const message = approved
      ? `Approved: ${formatAmount(amountCents, currency)} to ${vendor}`
      : (result.denial?.message ?? `Denied: ${result.reasonCode}`);

    const suggestion = result.denial?.hint ?? null;

    let retryWith: SpendResult['retryWith'] = null;
    if (result.denial?.actionable) {
      const available = (result.denial.actionable as Record<string, unknown>)
        .available_cents as number | undefined;
      if (available != null && available > 0) {
        retryWith = { amount_cents: available };
      }
    }

    const spendResult = buildSpendResult({
      approved,
      decisionId: result.decisionId,
      decision: result.decision,
      reasonCode: result.reasonCode,
      message,
      suggestion,
      retryWith,
      seal: result.notarySeal as object | null,
      enforcementMode: result.enforcementMode,
      amountCents: result.amountCents,
      currency: result.currency,
      vendorId: result.vendorId,
      raw: result as unknown as object,
    });

    // Stderr denial logging
    if (!approved && this.logDenials) {
      this.logDenial(spendResult, vendor, amountCents, currency, result);
    }

    return spendResult;
  }

  /**
   * Reset all sandbox counters to zero. Only works in sandbox mode.
   */
  sandboxReset(): void {
    if (!this._sandbox) {
      throw new Error('sandboxReset() is only available in sandbox mode');
    }
    this.sandboxEngine!.reset();
  }

  /**
   * Check current budget for the configured mandate.
   * Signs and submits to /v1/mandates/:id/budget.
   */
  async checkBudget(): Promise<BudgetResult> {
    if (this._sandbox) {
      const raw = this.sandboxEngine!.getBudget();
      return parseBudgetResult(raw);
    }

    const body = { mandate_id: this.mandate };
    const canonical = canonicalize(body as Record<string, unknown>);
    const signature = sign(canonical, this.signingKey!);

    const response = await fetch(
      `${this.baseUrl}/v1/mandates/${this.mandate}/budget`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Id': this.agentId,
          'X-Agent-Signature': signature,
        },
        body: JSON.stringify(body),
      },
    );

    if (response.status === 404) {
      throw new KoraError('NOT_FOUND', 'Mandate not found or revoked', 404);
    }

    if (response.status >= 400) {
      const raw = await response.json();
      const error = raw.error ?? {};
      throw new KoraError(
        error.code ?? 'UNKNOWN_ERROR',
        error.message ?? `HTTP ${response.status}`,
        response.status,
      );
    }

    const raw = await response.json();
    return parseBudgetResult(raw);
  }

  private logDenialSimple(
    spendResult: SpendResult,
    vendor: string,
    amountCents: number,
    currency: string,
  ): void {
    const parts: string[] = [
      'KORA_DENIAL',
      `agent=${this.agentId}`,
      `mandate=${this.mandate}`,
      `vendor=${vendor}`,
      `amount=${amountCents}`,
      `currency=${currency}`,
      `reason=${spendResult.reasonCode}`,
    ];

    if (spendResult.retryWith) {
      parts.push(`remaining_cents=${spendResult.retryWith.amount_cents}`);
    }

    console.error(parts.join(' '));
  }

  private logDenial(
    spendResult: SpendResult,
    vendor: string,
    amountCents: number,
    currency: string,
    engineResult: AuthorizationResult,
  ): void {
    const parts: string[] = [
      'KORA_DENIAL',
      `agent=${this.agentId}`,
      `mandate=${this.mandate}`,
      `vendor=${vendor}`,
      `amount=${amountCents}`,
      `currency=${currency}`,
      `reason=${spendResult.reasonCode}`,
    ];

    if (spendResult.retryWith) {
      parts.push(`remaining_cents=${spendResult.retryWith.amount_cents}`);
    }

    if (engineResult.traceUrl) {
      parts.push(`trace=${this.baseUrl}${engineResult.traceUrl}`);
    }

    console.error(parts.join(' '));
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build SpendResult from a response dict.
 *
 * Tolerant of missing/extra fields — handles both v1.3 API shape
 * and old cached responses (pre-v1.3 with payment_instruction).
 * Used by spend() and sandbox.
 *
 * NOTE: Idempotent replays of pre-v1.3 authorizations may return the old
 * response shape (with payment_instruction, without amount_cents at root).
 * Defensive parsing pulls amount_cents/currency from payment_instruction
 * as fallback if not found at root level.
 */
export function buildSpendResult(raw: Record<string, any>): SpendResult {
  const approved = raw.approved ?? (raw.decision === 'APPROVED');

  // Message: direct or from denial
  let message: string = raw.message ?? '';
  if (!message) {
    const denial = raw.denial;
    if (denial?.message) {
      message = denial.message;
    } else {
      const rc = raw.reason_code ?? raw.reasonCode ?? '';
      message = approved ? `Approved: ${rc}` : `Denied: ${rc}`;
    }
  }

  // Suggestion: direct or from denial.hint
  let suggestion: string | null = raw.suggestion ?? null;
  if (suggestion === null && raw.denial?.hint) {
    suggestion = raw.denial.hint;
  }

  // retry_with: direct or from denial.actionable
  let retryWith: { amount_cents: number } | null = raw.retry_with ?? raw.retryWith ?? null;
  if (retryWith === null && raw.denial?.actionable) {
    const available = raw.denial.actionable.available_cents;
    if (available != null && available > 0) {
      retryWith = { amount_cents: available };
    }
  }

  // Seal: from seal (sandbox) or notary_seal (API) or notarySeal (TS obj)
  const seal = raw.seal ?? raw.notary_seal ?? raw.notarySeal ?? null;

  // Defensive parsing for backward compat with pre-v1.3 cached responses:
  // Old responses may have amount_cents/currency inside payment_instruction.
  const piFallback = raw.payment_instruction ?? raw.paymentInstruction ?? {};
  const enforcementMode = raw.enforcement_mode ?? raw.enforcementMode ?? 'enforce';
  const amountCents = raw.amount_cents ?? raw.amountCents ?? piFallback.amount_cents ?? null;
  const currency = raw.currency ?? piFallback.currency ?? null;
  const vendorId = raw.vendor_id ?? raw.vendorId ?? null;

  return {
    approved,
    decisionId: raw.decision_id ?? raw.decisionId ?? '',
    decision: raw.decision ?? '',
    reasonCode: raw.reason_code ?? raw.reasonCode ?? '',
    message,
    suggestion,
    retryWith,
    seal,
    enforcementMode,
    amountCents,
    currency,
    vendorId,
    raw: raw.raw ?? raw,
  };
}

function parseBudgetResult(raw: Record<string, any>): BudgetResult {
  const daily = raw.daily;
  const monthly = raw.monthly;

  let velocity: BudgetResult['velocity'] = null;
  if (raw.velocity) {
    velocity = {
      windowMaxCents: raw.velocity.window_max_cents,
      windowSpentCents: raw.velocity.window_spent_cents,
      windowRemainingCents: raw.velocity.window_remaining_cents,
      windowResetsInSeconds: raw.velocity.window_resets_in_seconds,
    };
  }

  let timeWindow: BudgetResult['timeWindow'] = null;
  if (raw.time_window) {
    timeWindow = {
      allowedDays: raw.time_window.allowed_days,
      allowedHoursLocal: raw.time_window.allowed_hours_local,
      currentlyOpen: raw.time_window.currently_open,
      nextOpenAt: raw.time_window.next_open_at ?? null,
    };
  }

  return {
    currency: raw.currency,
    status: raw.status,
    spendAllowed: raw.spend_allowed,
    enforcementMode: raw.enforcement_mode ?? 'enforce',
    daily: {
      limitCents: daily.limit_cents,
      spentCents: daily.spent_cents,
      remainingCents: daily.remaining_cents,
      resetsAt: daily.resets_at,
    },
    monthly: {
      limitCents: monthly.limit_cents,
      spentCents: monthly.spent_cents,
      remainingCents: monthly.remaining_cents,
      resetsAt: monthly.resets_at,
    },
    perTransactionMaxCents: raw.per_transaction_max_cents ?? null,
    velocity,
    allowedVendors: raw.allowed_vendors ?? null,
    allowedCategories: raw.allowed_categories ?? null,
    timeWindow,
    raw,
  };
}
