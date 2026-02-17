/** Parameters for an authorization request. */
export interface AuthorizeParams {
  /** Mandate ID (UUID format). */
  mandate: string;
  /** Amount in cents (positive integer). */
  amount: number;
  /** 3-character ISO 4217 currency code. */
  currency: string;
  /** Vendor identifier. */
  vendor: string;
  /** Spend category (required when mandate has category_allowlist). */
  category?: string;
  /** Human-readable purpose. */
  purpose?: string;
  /** TTL in seconds (60-3600, default 300). */
  ttl?: number;
  /** Payment instruction details. */
  paymentInstruction?: PaymentInstruction;
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

/** Options for authorize call (e.g. simulation). */
export interface AuthorizeOptions {
  /** Reason code for simulation mode (requires adminKey). */
  simulate?: string;
  /** Admin API key (kora_admin_sk_...) for simulation Authorization header. */
  adminKey?: string;
}

/** Payment instruction details. */
export interface PaymentInstruction {
  recipientIban?: string;
  recipientName?: string;
  recipientBic?: string;
  paymentReference?: string;
}

/** Spending limits (after approval or current). */
export interface Limits {
  dailyRemainingCents?: number;
  monthlyRemainingCents?: number;
  dailySpentCents?: number;
  monthlySpentCents?: number;
  dailyLimitCents: number;
  monthlyLimitCents: number;
}

/** Denial details returned on DENIED decisions. */
export interface DenialObject {
  reasonCode: string;
  message: string;
  hint: string;
  actionable: Record<string, unknown>;
  failedCheck?: Record<string, unknown>;
}

/** Notary seal (Ed25519 signature over the decision). */
export interface NotarySeal {
  signature: string;
  publicKeyId: string;
  algorithm: string;
  signedFields: string[];
  timestamp: string;
  payloadHash?: string;
}

/** Step-by-step evaluation trace. */
export interface EvaluationTrace {
  steps: Array<{
    step: number;
    check: string;
    result: string;
    durationMs?: number;
    input?: Record<string, unknown>;
  }>;
  totalDurationMs: number;
}

/** Full authorization result with computed properties. */
export interface AuthorizationResult {
  decisionId: string;
  intentId: string;
  decision: 'APPROVED' | 'DENIED';
  reasonCode: string;
  agentId: string;
  mandateId: string | null;
  mandateVersion: number | null;
  amountCents?: number;
  currency?: string;
  vendorId?: string;
  evaluatedAt: string;
  expiresAt?: string;
  ttlSeconds?: number;
  notarySeal: NotarySeal | null;
  limitsAfterApproval: Limits | null;
  limitsCurrent: Limits | null;
  paymentInstruction: PaymentInstruction | null;
  denial: DenialObject | null;
  evaluationTrace: EvaluationTrace | null;
  traceUrl: string | null;
  executable: boolean;
  enforcementMode: string | null;
  simulated: boolean;

  /** True if decision === 'APPROVED'. */
  approved: boolean;
  /** True if TTL has not expired. */
  isValid: boolean;
  /** True if enforcement_mode === 'enforce'. */
  isEnforced: boolean;
}

/** Constructor options for the Kora client. */
export interface KoraOptions {
  /** Base URL of the Kora API (default: http://localhost:8000). */
  baseUrl?: string;
  /** Default TTL in seconds (default: 300). */
  ttl?: number;
  /** Maximum number of retries on network errors (default: 2). */
  maxRetries?: number;
}

/** Raw API response shape (snake_case). */
export interface RawApiResponse {
  decision_id?: string;
  intent_id?: string;
  decision?: string;
  status?: string;
  reason_code?: string;
  agent_id?: string;
  mandate_id?: string | null;
  mandate_version?: number | null;
  amount_cents?: number;
  currency?: string;
  vendor_id?: string;
  evaluated_at?: string;
  expires_at?: string;
  ttl_seconds?: number;
  notary_seal?: RawNotarySeal | null;
  limits_after_approval?: RawLimits | null;
  limits_current?: RawLimits | null;
  payment_instruction?: RawPaymentInstruction | null;
  denial?: RawDenialObject | null;
  evaluation_trace?: RawEvaluationTrace | null;
  trace_url?: string | null;
  executable?: boolean;
  enforcement_mode?: string | null;
  simulated?: boolean;
  // Error fields
  error?: string;
  message?: string;
}

export interface RawNotarySeal {
  signature: string;
  public_key_id: string;
  algorithm: string;
  signed_fields: string[];
  timestamp: string;
  payload_hash?: string;
}

export interface RawLimits {
  daily_remaining_cents?: number;
  monthly_remaining_cents?: number;
  daily_spent_cents?: number;
  monthly_spent_cents?: number;
  daily_limit_cents: number;
  monthly_limit_cents: number;
}

export interface RawPaymentInstruction {
  recipient_iban?: string;
  recipient_name?: string;
  recipient_bic?: string;
  payment_reference?: string;
  vendor_id?: string;
}

export interface RawDenialObject {
  reason_code: string;
  message: string;
  hint: string;
  actionable: Record<string, unknown>;
  failed_check?: Record<string, unknown>;
}

export interface RawEvaluationTrace {
  steps: Array<{
    step: number;
    check: string;
    result: string;
    duration_ms?: number;
    input?: Record<string, unknown>;
  }>;
  total_duration_ms: number;
}
