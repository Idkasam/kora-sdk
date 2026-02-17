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
  payment: {
    iban: string;
    bic: string;
    name: string;
    reference: string | null;
  } | null;
  executable: boolean;
  seal: object | null;
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
  secret: string;
  mandate: string;
  baseUrl?: string;
  logDenials?: boolean;
}

// ---------------------------------------------------------------------------
// Simplified Kora class
// ---------------------------------------------------------------------------

export class Kora {
  private readonly engine: KoraEngine;
  private readonly mandate: string;
  private readonly agentId: string;
  private readonly signingKey: Uint8Array;
  private readonly baseUrl: string;
  private readonly logDenials: boolean;

  constructor(config: KoraConfig) {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.engine = new KoraEngine(config.secret, { baseUrl });
    this.mandate = config.mandate;
    this.baseUrl = baseUrl;
    this.logDenials = config.logDenials ?? true;

    // Extract agent credentials for budget signing
    const parsed = parseAgentKey(config.secret);
    this.agentId = parsed.agentId;
    this.signingKey = parsed.signingKey;
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
    const params: Record<string, unknown> = {
      mandate: this.mandate,
      amount: amountCents,
      currency,
      vendor,
    };
    if (reason !== undefined) {
      (params as Record<string, unknown>).purpose = reason;
    }

    const result: AuthorizationResult = await this.engine.authorize(
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

    let payment: SpendResult['payment'] = null;
    if (result.paymentInstruction) {
      const pi = result.paymentInstruction;
      payment = {
        iban: pi.recipientIban ?? '',
        bic: pi.recipientBic ?? '',
        name: pi.recipientName ?? '',
        reference: pi.paymentReference ?? null,
      };
    }

    const spendResult: SpendResult = {
      approved,
      decisionId: result.decisionId,
      decision: result.decision,
      reasonCode: result.reasonCode,
      message,
      suggestion,
      retryWith,
      payment,
      executable: result.executable,
      seal: result.notarySeal as object | null,
      raw: result as unknown as object,
    };

    // Stderr denial logging
    if (!approved && this.logDenials) {
      this.logDenial(spendResult, vendor, amountCents, currency, result);
    }

    return spendResult;
  }

  /**
   * Check current budget for the configured mandate.
   * Signs and submits to /v1/mandates/:id/budget.
   */
  async checkBudget(): Promise<BudgetResult> {
    const body = { mandate_id: this.mandate };
    const canonical = canonicalize(body as Record<string, unknown>);
    const signature = sign(canonical, this.signingKey);

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
