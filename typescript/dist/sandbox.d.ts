export interface SandboxConfig {
    dailyLimitCents?: number;
    monthlyLimitCents?: number;
    currency?: string;
    perTransactionMaxCents?: number | null;
    allowedVendors?: string[] | null;
}
export declare class SandboxEngine {
    private readonly dailyLimit;
    private readonly monthlyLimit;
    private readonly currency;
    private readonly perTxMax;
    private readonly allowedVendors;
    private dailySpent;
    private monthlySpent;
    private txCount;
    private warned;
    private startDate;
    constructor(config?: SandboxConfig);
    private warnOnce;
    private autoResetIfNewDay;
    private formatEuros;
    spend(vendor: string, amountCents: number, currency: string, _reason?: string): Record<string, any>;
    private static buildSandboxPayment;
    private buildDenied;
    getBudget(): Record<string, any>;
    reset(): void;
}
