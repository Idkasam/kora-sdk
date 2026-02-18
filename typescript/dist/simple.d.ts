import type { SandboxConfig } from './sandbox.js';
export interface SpendResult {
    approved: boolean;
    decisionId: string;
    decision: 'APPROVED' | 'DENIED';
    reasonCode: string;
    message: string;
    suggestion: string | null;
    retryWith: {
        amount_cents: number;
    } | null;
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
        allowedHoursLocal: {
            start: string;
            end: string;
        };
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
export declare class Kora {
    private readonly engine;
    private readonly sandboxEngine;
    private readonly _sandbox;
    private readonly mandate;
    private readonly agentId;
    private readonly signingKey;
    private readonly baseUrl;
    private readonly logDenials;
    constructor(config?: KoraConfig);
    /**
     * Request authorization to spend.
     * Signs and submits to /v1/authorize.
     */
    spend(vendor: string, amountCents: number, currency: string, reason?: string): Promise<SpendResult>;
    /**
     * Reset all sandbox counters to zero. Only works in sandbox mode.
     */
    sandboxReset(): void;
    /**
     * Check current budget for the configured mandate.
     * Signs and submits to /v1/mandates/:id/budget.
     */
    checkBudget(): Promise<BudgetResult>;
    private logDenialSimple;
    private logDenial;
}
/**
 * Build SpendResult from a response dict.
 *
 * Tolerant of missing/extra fields — handles both current API shape
 * (payment_instruction, notary_seal, denial) and future shape
 * (no payment_instruction, enforcement_mode at root).
 * Used by spend() and sandbox.
 */
export declare function buildSpendResult(raw: Record<string, any>): SpendResult;
