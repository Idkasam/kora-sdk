/**
 * KoraAuto — scan-mode SDK for spend observation (no signing, no enforcement).
 *
 * Emits spend-intent signals to Kora's observation endpoint. Observations are
 * used by admins to discover candidate agents for delegation.
 *
 * Errors are logged to stderr (prefix KORA_SCAN_WARN), never thrown.
 */
export interface KoraAutoConfig {
    scanToken: string;
    baseUrl?: string;
}
export interface ObserveParams {
    vendor: string;
    amountCents?: number;
    currency?: string;
    reason?: string;
    serviceName?: string;
    environment?: string;
    runtimeId?: string;
    repoHint?: string;
}
export declare class KoraAuto {
    private scanToken;
    private baseUrl;
    private warnThrottle;
    constructor(config: KoraAutoConfig);
    observe(params: ObserveParams): Promise<{
        status: string;
    }>;
    private warn;
}
