"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Kora = void 0;
exports.parseResponse = parseResponse;
const node_crypto_1 = require("node:crypto");
const crypto_js_1 = require("./crypto.js");
const errors_js_1 = require("./errors.js");
const DEFAULT_BASE_URL = 'http://localhost:8000';
const DEFAULT_TTL = 300;
const DEFAULT_MAX_RETRIES = 2;
/**
 * Kora authorization SDK client.
 *
 * @example
 * ```ts
 * const kora = new Kora('kora_agent_sk_...');
 * const auth = await kora.authorize({
 *   mandate: 'mandate_abc123',
 *   amount: 50_00,
 *   currency: 'EUR',
 *   vendor: 'aws',
 * });
 * ```
 */
class Kora {
    agentId;
    signingKey;
    baseUrl;
    defaultTtl;
    maxRetries;
    constructor(keyString, options) {
        const parsed = (0, crypto_js_1.parseAgentKey)(keyString);
        this.agentId = parsed.agentId;
        this.signingKey = parsed.signingKey;
        this.baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
        this.defaultTtl = options?.ttl ?? DEFAULT_TTL;
        this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    }
    /**
     * Submit an authorization request.
     *
     * Returns an AuthorizationResult. On DENIED decisions, logs the trace URL
     * to stderr. On network errors, retries with the same intent_id.
     */
    async authorize(params, options) {
        const intentId = (0, node_crypto_1.randomUUID)();
        const ttlSeconds = params.ttl ?? this.defaultTtl;
        let lastError = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            // Generate a fresh nonce for each attempt (server deduplicates on intent_id)
            const nonce = (0, node_crypto_1.randomBytes)(16).toString('base64');
            const signedFields = (0, crypto_js_1.buildSignedFields)({
                intentId,
                agentId: this.agentId,
                mandateId: params.mandate,
                amountCents: params.amount,
                currency: params.currency,
                vendorId: params.vendor,
                nonce,
                ttlSeconds,
                paymentInstruction: params.paymentInstruction
                    ? {
                        recipientIban: params.paymentInstruction.recipientIban,
                        recipientName: params.paymentInstruction.recipientName,
                        recipientBic: params.paymentInstruction.recipientBic,
                        paymentReference: params.paymentInstruction.paymentReference,
                    }
                    : null,
                metadata: params.metadata ?? null,
            });
            const canonical = (0, crypto_js_1.canonicalize)(signedFields);
            const signature = (0, crypto_js_1.sign)(canonical, this.signingKey);
            const body = {
                intent_id: intentId,
                agent_id: this.agentId,
                mandate_id: params.mandate,
                amount_cents: params.amount,
                currency: params.currency,
                vendor_id: params.vendor,
                nonce,
                ttl_seconds: ttlSeconds,
            };
            if (params.category)
                body.category = params.category;
            if (params.purpose)
                body.purpose = params.purpose;
            if (params.paymentInstruction) {
                const pi = {};
                if (params.paymentInstruction.recipientIban)
                    pi.recipient_iban = params.paymentInstruction.recipientIban;
                if (params.paymentInstruction.recipientName)
                    pi.recipient_name = params.paymentInstruction.recipientName;
                if (params.paymentInstruction.recipientBic)
                    pi.recipient_bic = params.paymentInstruction.recipientBic;
                if (params.paymentInstruction.paymentReference)
                    pi.payment_reference = params.paymentInstruction.paymentReference;
                body.payment_instruction = pi;
            }
            if (params.metadata)
                body.metadata = params.metadata;
            const headers = {
                'Content-Type': 'application/json',
                'X-Agent-Signature': signature,
                'X-Agent-Id': this.agentId,
            };
            // Simulation headers
            if (options?.simulate) {
                headers['X-Kora-Simulate'] = options.simulate;
                if (options.adminKey) {
                    headers['Authorization'] = `Bearer ${options.adminKey}`;
                }
            }
            try {
                const response = await fetch(`${this.baseUrl}/v1/authorize`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                });
                const raw = await response.json();
                // HTTP error (not a denial — denials are HTTP 200)
                if (response.status >= 400) {
                    throw new errors_js_1.KoraError(raw.error ?? 'UNKNOWN_ERROR', raw.message ?? `HTTP ${response.status}`, response.status);
                }
                const result = parseResponse(raw);
                // Log trace URL on denial
                if (result.decision === 'DENIED' && result.traceUrl) {
                    console.error(`[kora] DENIED: ${result.reasonCode} — trace: ${this.baseUrl}${result.traceUrl}`);
                }
                return result;
            }
            catch (err) {
                // Only retry on network-level errors (not HTTP errors)
                if (err instanceof errors_js_1.KoraError)
                    throw err;
                const isNetworkError = err instanceof TypeError || // fetch network error
                    (err instanceof Error &&
                        ('code' in err &&
                            ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'].includes(err.code ?? '')));
                if (!isNetworkError || attempt === this.maxRetries) {
                    throw err;
                }
                lastError = err;
                // Retry with new nonce, same intentId
            }
        }
        throw lastError ?? new Error('Authorization failed after retries');
    }
    /**
     * Verify a notary seal on an authorization result.
     *
     * Reconstructs the decision payload from the signed_fields list, SHA-256
     * hashes it, and verifies the Ed25519 signature against the provided
     * Kora public key.
     */
    verifySeal(result, koraPublicKey) {
        if (!result.notarySeal)
            return false;
        const seal = result.notarySeal;
        // Reconstruct the decision payload from the signed fields
        const fieldMap = {
            intent_id: result.intentId,
            mandate_id: result.mandateId,
            mandate_version: result.mandateVersion,
            status: result.decision,
            reason_code: result.reasonCode,
            amount_cents: result.amountCents,
            currency: result.currency,
            vendor_id: result.vendorId,
            nonce: undefined, // not available in parsed response — use from signed_fields presence
            evaluated_at: result.evaluatedAt,
            ttl_seconds: result.ttlSeconds,
            enforcement_mode: result.enforcementMode,
            executable: result.executable,
        };
        // Build the decision payload using only the fields listed in signed_fields
        const decisionPayload = {};
        for (const field of seal.signedFields) {
            if (field in fieldMap) {
                decisionPayload[field] = fieldMap[field];
            }
        }
        return (0, crypto_js_1.verifySeal)(decisionPayload, seal.signature, koraPublicKey);
    }
    /**
     * Generate an OpenAI function calling schema for authorization.
     *
     * @param mandate - The mandate ID to bind the tool to.
     * @param categoryEnum - Optional list of allowed categories for the enum constraint.
     */
    asTool(mandate, categoryEnum) {
        const properties = {
            amount_cents: {
                type: 'integer',
                description: 'Amount in cents (positive integer)',
            },
            currency: {
                type: 'string',
                description: '3-character ISO 4217 currency code (e.g. EUR, USD)',
            },
            vendor_id: {
                type: 'string',
                description: 'Vendor identifier (e.g. aws, stripe, openai)',
            },
        };
        if (categoryEnum && categoryEnum.length > 0) {
            properties.category = {
                type: 'string',
                enum: categoryEnum,
                description: 'Spend category',
            };
        }
        else {
            properties.category = {
                type: 'string',
                description: 'Spend category (optional)',
            };
        }
        properties.purpose = {
            type: 'string',
            description: 'Human-readable purpose for the spend',
        };
        return {
            type: 'function',
            function: {
                name: 'kora_authorize_spend',
                description: `Request authorization to spend money via Kora. Mandate: ${mandate}. ` +
                    'Returns APPROVED or DENIED with reason code.',
                parameters: {
                    type: 'object',
                    properties,
                    required: ['amount_cents', 'currency', 'vendor_id'],
                },
            },
        };
    }
}
exports.Kora = Kora;
// ---------------------------------------------------------------------------
// Response parsing: snake_case API → camelCase TypeScript
// ---------------------------------------------------------------------------
function parseResponse(raw) {
    const decision = (raw.decision ?? raw.status ?? 'DENIED');
    const evaluatedAt = raw.evaluated_at ?? new Date().toISOString();
    const expiresAt = raw.expires_at ?? null;
    return {
        decisionId: raw.decision_id ?? '',
        intentId: raw.intent_id ?? '',
        decision,
        reasonCode: raw.reason_code ?? '',
        agentId: raw.agent_id ?? '',
        mandateId: raw.mandate_id ?? null,
        mandateVersion: raw.mandate_version ?? null,
        amountCents: raw.amount_cents,
        currency: raw.currency,
        vendorId: raw.vendor_id,
        evaluatedAt,
        expiresAt: expiresAt ?? undefined,
        ttlSeconds: raw.ttl_seconds,
        notarySeal: raw.notary_seal ? parseSeal(raw.notary_seal) : null,
        limitsAfterApproval: raw.limits_after_approval
            ? parseLimits(raw.limits_after_approval)
            : null,
        limitsCurrent: raw.limits_current ? parseLimits(raw.limits_current) : null,
        paymentInstruction: raw.payment_instruction
            ? parsePaymentInstruction(raw.payment_instruction)
            : null,
        denial: raw.denial ? parseDenial(raw.denial) : null,
        evaluationTrace: raw.evaluation_trace
            ? parseTrace(raw.evaluation_trace)
            : null,
        traceUrl: raw.trace_url ?? null,
        executable: raw.executable ?? false,
        enforcementMode: raw.enforcement_mode ?? null,
        simulated: raw.simulated ?? false,
        // Computed properties
        approved: decision === 'APPROVED',
        isValid: expiresAt ? new Date(expiresAt) > new Date() : true,
        isEnforced: (raw.enforcement_mode ?? 'enforce') === 'enforce',
    };
}
function parseSeal(raw) {
    return {
        signature: raw.signature,
        publicKeyId: raw.public_key_id,
        algorithm: raw.algorithm,
        signedFields: raw.signed_fields,
        timestamp: raw.timestamp,
        payloadHash: raw.payload_hash,
    };
}
function parseLimits(raw) {
    return {
        dailyRemainingCents: raw.daily_remaining_cents,
        monthlyRemainingCents: raw.monthly_remaining_cents,
        dailySpentCents: raw.daily_spent_cents,
        monthlySpentCents: raw.monthly_spent_cents,
        dailyLimitCents: raw.daily_limit_cents,
        monthlyLimitCents: raw.monthly_limit_cents,
    };
}
function parsePaymentInstruction(raw) {
    return {
        recipientIban: raw.recipient_iban,
        recipientName: raw.recipient_name,
        recipientBic: raw.recipient_bic,
        paymentReference: raw.payment_reference,
    };
}
function parseDenial(raw) {
    return {
        reasonCode: raw.reason_code,
        message: raw.message,
        hint: raw.hint,
        actionable: raw.actionable,
        failedCheck: raw.failed_check,
    };
}
function parseTrace(raw) {
    return {
        steps: raw.steps.map((s) => ({
            step: s.step,
            check: s.check,
            result: s.result,
            durationMs: s.duration_ms,
            input: s.input,
        })),
        totalDurationMs: raw.total_duration_ms,
    };
}
