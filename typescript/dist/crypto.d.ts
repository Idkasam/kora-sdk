/** Parsed agent key containing agent_id and raw Ed25519 private key. */
export interface ParsedAgentKey {
    agentId: string;
    /** 64-byte Ed25519 signing key (seed + public key) for tweetnacl. */
    signingKey: Uint8Array;
}
/**
 * Parse a kora_agent_sk_... key string.
 *
 * Format: kora_agent_sk_<base64(agent_id:private_key_hex)>
 * The private_key_hex is the 32-byte Ed25519 seed.
 */
export declare function parseAgentKey(keyString: string): ParsedAgentKey;
/**
 * Recursively sort object keys for deterministic JSON serialization.
 * Matches Python's json.dumps(obj, sort_keys=True).
 */
export declare function sortKeysDeep(obj: unknown): unknown;
/**
 * Canonicalize a JSON object to bytes.
 * Matches Python's: json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
 *
 * JS JSON.stringify already uses compact separators (no extra spaces).
 */
export declare function canonicalize(obj: Record<string, unknown>): Uint8Array;
/**
 * Sign a canonical payload with Ed25519.
 * Returns base64-encoded detached signature.
 */
export declare function sign(message: Uint8Array, signingKey: Uint8Array): string;
/**
 * Verify an Ed25519 detached signature.
 * @param message - The original message bytes.
 * @param signatureB64 - Base64-encoded signature.
 * @param publicKeyB64 - Base64-encoded Ed25519 public key.
 */
export declare function verify(message: Uint8Array, signatureB64: string, publicKeyB64: string): boolean;
/**
 * Verify a notary seal on a decision.
 *
 * The server signs SHA-256(canonicalize(decision_payload)) with Ed25519.
 * We reconstruct the decision_payload from the response and signed_fields list.
 */
export declare function verifySeal(decisionPayload: Record<string, unknown>, signatureB64: string, publicKeyB64: string): boolean;
/**
 * Build the signed_fields object from authorize parameters.
 * Must match the server's construction in src/pipeline.py verify_signature_with_key.
 */
export declare function buildSignedFields(params: {
    intentId: string;
    agentId: string;
    mandateId: string;
    amountCents: number;
    currency: string;
    vendorId: string;
    nonce: string;
    ttlSeconds: number;
    paymentInstruction?: {
        recipientIban?: string;
        recipientName?: string;
        recipientBic?: string;
        paymentReference?: string;
    } | null;
    metadata?: Record<string, unknown> | null;
}): Record<string, unknown>;
