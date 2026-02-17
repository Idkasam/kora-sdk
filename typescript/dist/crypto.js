"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAgentKey = parseAgentKey;
exports.sortKeysDeep = sortKeysDeep;
exports.canonicalize = canonicalize;
exports.sign = sign;
exports.verify = verify;
exports.verifySeal = verifySeal;
exports.buildSignedFields = buildSignedFields;
const tweetnacl_1 = __importDefault(require("tweetnacl"));
const node_crypto_1 = require("node:crypto");
const AGENT_SK_PREFIX = 'kora_agent_sk_';
/**
 * Parse a kora_agent_sk_... key string.
 *
 * Format: kora_agent_sk_<base64(agent_id:private_key_hex)>
 * The private_key_hex is the 32-byte Ed25519 seed.
 */
function parseAgentKey(keyString) {
    if (!keyString.startsWith(AGENT_SK_PREFIX)) {
        throw new Error(`Invalid agent key: must start with "${AGENT_SK_PREFIX}"`);
    }
    const encoded = keyString.slice(AGENT_SK_PREFIX.length);
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
        throw new Error('Invalid agent key: missing agent_id:private_key separator');
    }
    const agentId = decoded.slice(0, colonIndex);
    const privateHex = decoded.slice(colonIndex + 1);
    if (!agentId) {
        throw new Error('Invalid agent key: empty agent_id');
    }
    if (privateHex.length !== 64) {
        throw new Error('Invalid agent key: private key must be 32 bytes (64 hex chars)');
    }
    // Convert hex to bytes (32-byte seed)
    const seed = hexToBytes(privateHex);
    // tweetnacl expects a 64-byte "secretKey" (seed + public key)
    const keypair = tweetnacl_1.default.sign.keyPair.fromSeed(seed);
    return { agentId, signingKey: keypair.secretKey };
}
/**
 * Recursively sort object keys for deterministic JSON serialization.
 * Matches Python's json.dumps(obj, sort_keys=True).
 */
function sortKeysDeep(obj) {
    if (Array.isArray(obj)) {
        return obj.map(sortKeysDeep);
    }
    if (obj !== null && typeof obj === 'object') {
        const sorted = {};
        for (const key of Object.keys(obj).sort()) {
            sorted[key] = sortKeysDeep(obj[key]);
        }
        return sorted;
    }
    return obj;
}
/**
 * Canonicalize a JSON object to bytes.
 * Matches Python's: json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
 *
 * JS JSON.stringify already uses compact separators (no extra spaces).
 */
function canonicalize(obj) {
    const sorted = sortKeysDeep(obj);
    return new TextEncoder().encode(JSON.stringify(sorted));
}
/**
 * Sign a canonical payload with Ed25519.
 * Returns base64-encoded detached signature.
 */
function sign(message, signingKey) {
    const signature = tweetnacl_1.default.sign.detached(message, signingKey);
    return Buffer.from(signature).toString('base64');
}
/**
 * Verify an Ed25519 detached signature.
 * @param message - The original message bytes.
 * @param signatureB64 - Base64-encoded signature.
 * @param publicKeyB64 - Base64-encoded Ed25519 public key.
 */
function verify(message, signatureB64, publicKeyB64) {
    try {
        const sig = Buffer.from(signatureB64, 'base64');
        const pk = Buffer.from(publicKeyB64, 'base64');
        return tweetnacl_1.default.sign.detached.verify(message, sig, pk);
    }
    catch {
        return false;
    }
}
/**
 * Verify a notary seal on a decision.
 *
 * The server signs SHA-256(canonicalize(decision_payload)) with Ed25519.
 * We reconstruct the decision_payload from the response and signed_fields list.
 */
function verifySeal(decisionPayload, signatureB64, publicKeyB64) {
    const canonical = canonicalize(decisionPayload);
    const hash = (0, node_crypto_1.createHash)('sha256').update(canonical).digest();
    return verify(hash, signatureB64, publicKeyB64);
}
/**
 * Build the signed_fields object from authorize parameters.
 * Must match the server's construction in src/pipeline.py verify_signature_with_key.
 */
function buildSignedFields(params) {
    const fields = {
        intent_id: params.intentId,
        agent_id: params.agentId,
        mandate_id: params.mandateId,
        amount_cents: params.amountCents,
        currency: params.currency,
        vendor_id: params.vendorId,
        nonce: params.nonce,
        ttl_seconds: params.ttlSeconds,
    };
    if (params.paymentInstruction) {
        const pi = {};
        if (params.paymentInstruction.recipientIban != null)
            pi.recipient_iban = params.paymentInstruction.recipientIban;
        if (params.paymentInstruction.recipientName != null)
            pi.recipient_name = params.paymentInstruction.recipientName;
        if (params.paymentInstruction.recipientBic != null)
            pi.recipient_bic = params.paymentInstruction.recipientBic;
        if (params.paymentInstruction.paymentReference != null)
            pi.payment_reference = params.paymentInstruction.paymentReference;
        if (Object.keys(pi).length > 0) {
            fields.payment_instruction = pi;
        }
    }
    if (params.metadata && Object.keys(params.metadata).length > 0) {
        fields.metadata = params.metadata;
    }
    return fields;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}
