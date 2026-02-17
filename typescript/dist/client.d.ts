import type { AuthorizeParams, AuthorizeOptions, AuthorizationResult, KoraOptions, RawApiResponse } from './types.js';
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
export declare class Kora {
    private readonly agentId;
    private readonly signingKey;
    private readonly baseUrl;
    private readonly defaultTtl;
    private readonly maxRetries;
    constructor(keyString: string, options?: KoraOptions);
    /**
     * Submit an authorization request.
     *
     * Returns an AuthorizationResult. On DENIED decisions, logs the trace URL
     * to stderr. On network errors, retries with the same intent_id.
     */
    authorize(params: AuthorizeParams, options?: AuthorizeOptions): Promise<AuthorizationResult>;
    /**
     * Verify a notary seal on an authorization result.
     *
     * Reconstructs the decision payload from the signed_fields list, SHA-256
     * hashes it, and verifies the Ed25519 signature against the provided
     * Kora public key.
     */
    verifySeal(result: AuthorizationResult, koraPublicKey: string): boolean;
    /**
     * Generate an OpenAI function calling schema for authorization.
     *
     * @param mandate - The mandate ID to bind the tool to.
     * @param categoryEnum - Optional list of allowed categories for the enum constraint.
     */
    asTool(mandate: string, categoryEnum?: string[]): {
        type: 'function';
        function: {
            name: string;
            description: string;
            parameters: Record<string, unknown>;
        };
    };
}
declare function parseResponse(raw: RawApiResponse): AuthorizationResult;
export { parseResponse };
