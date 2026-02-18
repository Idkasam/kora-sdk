"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SandboxEngine = void 0;
/**
 * Sandbox authorization engine — in-memory simulator with zero network calls.
 *
 * Tracks daily/monthly spend counters, enforces limits, and returns dicts
 * matching the shape expected by buildSpendResult() and parseBudgetResult().
 */
const node_crypto_1 = require("node:crypto");
const DEFAULT_SANDBOX_CONFIG = {
    dailyLimitCents: 1_000_000, // €10,000
    monthlyLimitCents: 5_000_000, // €50,000
    currency: 'EUR',
    perTransactionMaxCents: null, // null = no per-tx limit
    allowedVendors: null, // null = all vendors allowed
};
const SANDBOX_PAYMENT = {
    iban: 'XX00SANDBOX0000000001',
    bic: 'SANDBOXXXX',
    name: 'Sandbox Vendor',
};
// NOTE: Sandbox currently returns payment-related fields (payment, executable)
// for compatibility with the current server API response shape.
// These fields are DEPRECATED and will be removed when the server API
// drops payment_instruction from authorization responses (see
// KORA_REMOVE_PAYMENT_INSTRUCTION.md). When that happens:
//   - Delete this SANDBOX_PAYMENT object
//   - Delete buildSandboxPayment()
//   - Remove "payment" and "executable" keys from spend() return dict
// Real vendor routing (IBANs, Stripe IDs, etc.) is a V2 executor concern.
// These values are obviously fake and cannot be confused with real accounts.
class SandboxEngine {
    dailyLimit;
    monthlyLimit;
    currency;
    perTxMax;
    allowedVendors;
    dailySpent = 0;
    monthlySpent = 0;
    txCount = 0;
    warned = false;
    startDate;
    constructor(config) {
        const merged = { ...DEFAULT_SANDBOX_CONFIG, ...config };
        this.dailyLimit = merged.dailyLimitCents;
        this.monthlyLimit = merged.monthlyLimitCents;
        this.currency = merged.currency;
        this.perTxMax = merged.perTransactionMaxCents;
        this.allowedVendors = merged.allowedVendors;
        this.startDate = new Date().toISOString().slice(0, 10);
    }
    warnOnce() {
        if (!this.warned) {
            console.error('[KORA SANDBOX] Running in sandbox mode — no real authorizations are being made.');
            this.warned = true;
        }
    }
    autoResetIfNewDay() {
        const today = new Date().toISOString().slice(0, 10);
        if (today !== this.startDate) {
            this.dailySpent = 0;
            this.startDate = today;
            // Monthly reset on 1st
            if (new Date().getUTCDate() === 1) {
                this.monthlySpent = 0;
            }
        }
    }
    formatEuros(cents) {
        const whole = Math.floor(cents / 100);
        const frac = cents % 100;
        const formatted = whole.toLocaleString('en-US');
        return `€${formatted}.${String(frac).padStart(2, '0')}`;
    }
    spend(vendor, amountCents, currency, _reason) {
        this.warnOnce();
        this.autoResetIfNewDay();
        // --- Input validation (mirrors production) ---
        if (!Number.isInteger(amountCents) || amountCents <= 0) {
            throw new Error('amount_cents must be a positive integer');
        }
        if (!vendor || typeof vendor !== 'string') {
            throw new Error('vendor must be a non-empty string');
        }
        if (!currency || typeof currency !== 'string' || currency.length !== 3) {
            throw new Error('currency must be a 3-letter ISO 4217 code');
        }
        currency = currency.toUpperCase();
        vendor = vendor.trim().toLowerCase();
        const decisionId = `sandbox_${(0, node_crypto_1.randomUUID)().replace(/-/g, '')}`;
        const now = new Date();
        const nowIso = now.toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
        // --- Evaluation pipeline ---
        // Order: currency → vendor allowlist → per-tx → daily → monthly
        // Currency check
        if (currency !== this.currency) {
            return this.buildDenied(decisionId, nowIso, amountCents, currency, vendor, 'CURRENCY_MISMATCH', `Currency '${currency}' does not match mandate currency '${this.currency}'.`, null, null);
        }
        // Vendor allowlist
        if (this.allowedVendors !== null && !this.allowedVendors.includes(vendor)) {
            return this.buildDenied(decisionId, nowIso, amountCents, currency, vendor, 'VENDOR_NOT_ALLOWED', `Vendor '${vendor}' is not in the allowed vendor list.`, null, null);
        }
        // Per-transaction limit
        if (this.perTxMax !== null && amountCents > this.perTxMax) {
            return this.buildDenied(decisionId, nowIso, amountCents, currency, vendor, 'PER_TRANSACTION_LIMIT_EXCEEDED', `Per-transaction limit exceeded. Maximum: ${this.formatEuros(this.perTxMax)}.`, `Reduce amount to ${this.formatEuros(this.perTxMax)}.`, { amount_cents: this.perTxMax });
        }
        // Daily limit
        const dailyRemaining = this.dailyLimit - this.dailySpent;
        if (amountCents > dailyRemaining) {
            return this.buildDenied(decisionId, nowIso, amountCents, currency, vendor, 'DAILY_LIMIT_EXCEEDED', `Daily spending limit exceeded. Requested: ${this.formatEuros(amountCents)}. Available: ${this.formatEuros(dailyRemaining)}.`, `Reduce amount to ${this.formatEuros(dailyRemaining)} or wait for daily reset.`, dailyRemaining > 0 ? { amount_cents: dailyRemaining } : null);
        }
        // Monthly limit
        const monthlyRemaining = this.monthlyLimit - this.monthlySpent;
        if (amountCents > monthlyRemaining) {
            return this.buildDenied(decisionId, nowIso, amountCents, currency, vendor, 'MONTHLY_LIMIT_EXCEEDED', `Monthly spending limit exceeded. Requested: ${this.formatEuros(amountCents)}. Available: ${this.formatEuros(monthlyRemaining)}.`, `Reduce amount to ${this.formatEuros(monthlyRemaining)} or wait for monthly reset.`, monthlyRemaining > 0 ? { amount_cents: monthlyRemaining } : null);
        }
        // --- APPROVED ---
        this.dailySpent += amountCents;
        this.monthlySpent += amountCents;
        this.txCount += 1;
        const shortId = (0, node_crypto_1.randomUUID)().replace(/-/g, '').slice(0, 8);
        const sigHex = (0, node_crypto_1.randomUUID)().replace(/-/g, '');
        const expires = new Date(now.getTime() + 300_000);
        const expiresIso = expires.toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
        return {
            approved: true,
            decision_id: decisionId,
            decision: 'APPROVED',
            reason_code: 'OK',
            message: `Approved: ${this.formatEuros(amountCents)} to ${vendor}`,
            suggestion: null,
            retry_with: null,
            // FORWARD-COMPAT: payment + executable will be removed in next change.
            // buildSandboxPayment() isolates this so removal is one-line.
            payment: SandboxEngine.buildSandboxPayment(shortId),
            executable: true,
            // Forward-compat fields
            enforcement_mode: 'enforce',
            amount_cents: amountCents,
            currency,
            vendor_id: vendor,
            seal: {
                algorithm: 'Ed25519',
                signature: `sandbox_sig_${sigHex.slice(0, 32)}`,
                public_key_id: 'sandbox_key_v1',
                payload_hash: `sha256:sandbox_${sigHex.slice(0, 16)}`,
            },
            raw: {
                sandbox: true,
                decision: 'APPROVED',
                decision_id: decisionId,
                reason_code: 'OK',
                enforcement_mode: 'enforce',
                amount_cents: amountCents,
                currency,
                vendor_id: vendor,
                evaluated_at: nowIso,
                expires_at: expiresIso,
                limits_after_approval: {
                    daily_remaining_cents: this.dailyLimit - this.dailySpent,
                    monthly_remaining_cents: this.monthlyLimit - this.monthlySpent,
                },
            },
        };
    }
    static buildSandboxPayment(shortId) {
        return {
            iban: SANDBOX_PAYMENT.iban,
            bic: SANDBOX_PAYMENT.bic,
            name: SANDBOX_PAYMENT.name,
            reference: `KORA-SANDBOX-${shortId}`,
        };
    }
    buildDenied(decisionId, nowIso, _amountCents, _currency, _vendor, reasonCode, message, suggestion, retryWith) {
        return {
            approved: false,
            decision_id: decisionId,
            decision: 'DENIED',
            reason_code: reasonCode,
            message,
            suggestion,
            retry_with: retryWith,
            payment: null,
            executable: false,
            seal: null,
            raw: {
                sandbox: true,
                decision: 'DENIED',
                decision_id: decisionId,
                reason_code: reasonCode,
                evaluated_at: nowIso,
                limits_current: {
                    daily_spent_cents: this.dailySpent,
                    daily_limit_cents: this.dailyLimit,
                    monthly_spent_cents: this.monthlySpent,
                    monthly_limit_cents: this.monthlyLimit,
                },
            },
        };
    }
    getBudget() {
        this.warnOnce();
        this.autoResetIfNewDay();
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(0, 0, 0, 0);
        const nextMonth = new Date(Date.UTC(now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear(), (now.getUTCMonth() + 1) % 12, 1));
        const nowIso = now.toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
        // Format timestamps with Z suffix (not +00:00)
        const tomorrowIso = tomorrow.toISOString().replace(/\.\d{3}Z$/, 'Z');
        const nextMonthIso = nextMonth.toISOString().replace(/\.\d{3}Z$/, 'Z');
        return {
            currency: this.currency,
            status: 'active',
            spend_allowed: true,
            enforcement_mode: 'enforce',
            daily: {
                limit_cents: this.dailyLimit,
                spent_cents: this.dailySpent,
                remaining_cents: this.dailyLimit - this.dailySpent,
                resets_at: tomorrowIso,
            },
            monthly: {
                limit_cents: this.monthlyLimit,
                spent_cents: this.monthlySpent,
                remaining_cents: this.monthlyLimit - this.monthlySpent,
                resets_at: nextMonthIso,
            },
            per_transaction_max_cents: this.perTxMax,
            velocity: null,
            allowed_vendors: this.allowedVendors,
            allowed_categories: null,
            time_window: null,
            raw: { sandbox: true, checked_at: nowIso },
        };
    }
    reset() {
        this.dailySpent = 0;
        this.monthlySpent = 0;
        this.txCount = 0;
        this.startDate = new Date().toISOString().slice(0, 10);
    }
}
exports.SandboxEngine = SandboxEngine;
