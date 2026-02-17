"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Kora = void 0;
const client_js_1 = require("./client.js");
const crypto_js_1 = require("./crypto.js");
const errors_js_1 = require("./errors.js");
const format_js_1 = require("./format.js");
const DEFAULT_BASE_URL = 'https://api.koraprotocol.com';
// ---------------------------------------------------------------------------
// Simplified Kora class
// ---------------------------------------------------------------------------
class Kora {
    engine;
    mandate;
    agentId;
    signingKey;
    baseUrl;
    logDenials;
    constructor(config) {
        const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
        this.engine = new client_js_1.Kora(config.secret, { baseUrl });
        this.mandate = config.mandate;
        this.baseUrl = baseUrl;
        this.logDenials = config.logDenials ?? true;
        // Extract agent credentials for budget signing
        const parsed = (0, crypto_js_1.parseAgentKey)(config.secret);
        this.agentId = parsed.agentId;
        this.signingKey = parsed.signingKey;
    }
    /**
     * Request authorization to spend.
     * Signs and submits to /v1/authorize.
     */
    async spend(vendor, amountCents, currency, reason) {
        const params = {
            mandate: this.mandate,
            amount: amountCents,
            currency,
            vendor,
        };
        if (reason !== undefined) {
            params.purpose = reason;
        }
        const result = await this.engine.authorize(params);
        // Build SpendResult
        const approved = result.decision === 'APPROVED';
        const message = approved
            ? `Approved: ${(0, format_js_1.formatAmount)(amountCents, currency)} to ${vendor}`
            : (result.denial?.message ?? `Denied: ${result.reasonCode}`);
        const suggestion = result.denial?.hint ?? null;
        let retryWith = null;
        if (result.denial?.actionable) {
            const available = result.denial.actionable
                .available_cents;
            if (available != null && available > 0) {
                retryWith = { amount_cents: available };
            }
        }
        let payment = null;
        if (result.paymentInstruction) {
            const pi = result.paymentInstruction;
            payment = {
                iban: pi.recipientIban ?? '',
                bic: pi.recipientBic ?? '',
                name: pi.recipientName ?? '',
                reference: pi.paymentReference ?? null,
            };
        }
        const spendResult = {
            approved,
            decisionId: result.decisionId,
            decision: result.decision,
            reasonCode: result.reasonCode,
            message,
            suggestion,
            retryWith,
            payment,
            executable: result.executable,
            seal: result.notarySeal,
            raw: result,
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
    async checkBudget() {
        const body = { mandate_id: this.mandate };
        const canonical = (0, crypto_js_1.canonicalize)(body);
        const signature = (0, crypto_js_1.sign)(canonical, this.signingKey);
        const response = await fetch(`${this.baseUrl}/v1/mandates/${this.mandate}/budget`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Agent-Id': this.agentId,
                'X-Agent-Signature': signature,
            },
            body: JSON.stringify(body),
        });
        if (response.status === 404) {
            throw new errors_js_1.KoraError('NOT_FOUND', 'Mandate not found or revoked', 404);
        }
        if (response.status >= 400) {
            const raw = await response.json();
            const error = raw.error ?? {};
            throw new errors_js_1.KoraError(error.code ?? 'UNKNOWN_ERROR', error.message ?? `HTTP ${response.status}`, response.status);
        }
        const raw = await response.json();
        return parseBudgetResult(raw);
    }
    logDenial(spendResult, vendor, amountCents, currency, engineResult) {
        const parts = [
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
exports.Kora = Kora;
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function parseBudgetResult(raw) {
    const daily = raw.daily;
    const monthly = raw.monthly;
    let velocity = null;
    if (raw.velocity) {
        velocity = {
            windowMaxCents: raw.velocity.window_max_cents,
            windowSpentCents: raw.velocity.window_spent_cents,
            windowRemainingCents: raw.velocity.window_remaining_cents,
            windowResetsInSeconds: raw.velocity.window_resets_in_seconds,
        };
    }
    let timeWindow = null;
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
