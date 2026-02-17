import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import {
  parseAgentKey,
  sortKeysDeep,
  canonicalize,
  sign,
  verify,
  buildSignedFields,
} from '../src/crypto.js';

// Build a test agent key in the same format as the Python server
function buildTestAgentKey(agentId: string): {
  keyString: string;
  seed: Uint8Array;
  publicKey: Uint8Array;
} {
  const keypair = nacl.sign.keyPair();
  // Extract 32-byte seed from the 64-byte secretKey
  const seed = keypair.secretKey.slice(0, 32);
  const privateHex = Buffer.from(seed).toString('hex');
  const raw = `${agentId}:${privateHex}`;
  const encoded = Buffer.from(raw).toString('base64');
  const keyString = `kora_agent_sk_${encoded}`;
  return { keyString, seed, publicKey: keypair.publicKey };
}

describe('parseAgentKey', () => {
  it('parses a valid agent key string', () => {
    const { keyString } = buildTestAgentKey('agent_test_001');
    const parsed = parseAgentKey(keyString);
    expect(parsed.agentId).toBe('agent_test_001');
    expect(parsed.signingKey).toBeInstanceOf(Uint8Array);
    expect(parsed.signingKey.length).toBe(64); // tweetnacl 64-byte secretKey
  });

  it('throws on missing prefix', () => {
    expect(() => parseAgentKey('invalid_key')).toThrow('must start with');
  });

  it('throws on missing colon separator', () => {
    const encoded = Buffer.from('noColonHere').toString('base64');
    expect(() => parseAgentKey(`kora_agent_sk_${encoded}`)).toThrow('missing');
  });

  it('throws on empty agent_id', () => {
    const encoded = Buffer.from(`:${'ab'.repeat(32)}`).toString('base64');
    expect(() => parseAgentKey(`kora_agent_sk_${encoded}`)).toThrow('empty agent_id');
  });

  it('throws on invalid private key length', () => {
    const encoded = Buffer.from('agent:abc').toString('base64');
    expect(() => parseAgentKey(`kora_agent_sk_${encoded}`)).toThrow('32 bytes');
  });
});

describe('sortKeysDeep', () => {
  it('sorts top-level keys alphabetically', () => {
    const result = sortKeysDeep({ z: 1, a: 2, m: 3 }) as Record<string, number>;
    const keys = Object.keys(result);
    expect(keys).toEqual(['a', 'm', 'z']);
  });

  it('sorts nested object keys recursively', () => {
    const result = sortKeysDeep({
      b: { z: 1, a: 2 },
      a: 1,
    }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['a', 'b']);
    expect(Object.keys(result.b as object)).toEqual(['a', 'z']);
  });

  it('preserves arrays (does not sort array elements)', () => {
    const result = sortKeysDeep({ arr: [3, 1, 2] }) as { arr: number[] };
    expect(result.arr).toEqual([3, 1, 2]);
  });

  it('sorts keys inside array elements', () => {
    const result = sortKeysDeep({ arr: [{ z: 1, a: 2 }] }) as {
      arr: Array<Record<string, number>>;
    };
    expect(Object.keys(result.arr[0])).toEqual(['a', 'z']);
  });
});

describe('canonicalize', () => {
  it('produces compact JSON with sorted keys', () => {
    const bytes = canonicalize({ b: 2, a: 1 });
    const str = new TextDecoder().decode(bytes);
    expect(str).toBe('{"a":1,"b":2}');
  });

  it('matches Python output for nested objects', () => {
    const bytes = canonicalize({
      vendor_id: 'aws',
      amount_cents: 5000,
      agent_id: 'agent_test_001',
    });
    const str = new TextDecoder().decode(bytes);
    // Python: json.dumps({"vendor_id": "aws", "amount_cents": 5000, "agent_id": "agent_test_001"}, sort_keys=True, separators=(",",":"))
    // = {"agent_id":"agent_test_001","amount_cents":5000,"vendor_id":"aws"}
    expect(str).toBe('{"agent_id":"agent_test_001","amount_cents":5000,"vendor_id":"aws"}');
  });

  it('handles UTF-8 correctly', () => {
    const bytes = canonicalize({ name: 'café' });
    const str = new TextDecoder().decode(bytes);
    expect(str).toBe('{"name":"café"}');
  });
});

describe('sign + verify', () => {
  it('roundtrip: sign then verify succeeds', () => {
    const { keyString, publicKey } = buildTestAgentKey('test_agent');
    const parsed = parseAgentKey(keyString);
    const message = canonicalize({ hello: 'world' });
    const signature = sign(message, parsed.signingKey);
    const publicKeyB64 = Buffer.from(publicKey).toString('base64');
    expect(verify(message, signature, publicKeyB64)).toBe(true);
  });

  it('verify rejects tampered message', () => {
    const { keyString, publicKey } = buildTestAgentKey('test_agent');
    const parsed = parseAgentKey(keyString);
    const message = canonicalize({ hello: 'world' });
    const signature = sign(message, parsed.signingKey);
    const tampered = canonicalize({ hello: 'tampered' });
    const publicKeyB64 = Buffer.from(publicKey).toString('base64');
    expect(verify(tampered, signature, publicKeyB64)).toBe(false);
  });

  it('verify rejects wrong public key', () => {
    const { keyString } = buildTestAgentKey('test_agent');
    const otherKeypair = nacl.sign.keyPair();
    const parsed = parseAgentKey(keyString);
    const message = canonicalize({ hello: 'world' });
    const signature = sign(message, parsed.signingKey);
    const wrongKeyB64 = Buffer.from(otherKeypair.publicKey).toString('base64');
    expect(verify(message, signature, wrongKeyB64)).toBe(false);
  });
});

describe('buildSignedFields', () => {
  it('builds correct fields for basic request', () => {
    const fields = buildSignedFields({
      intentId: '11111111-2222-3333-4444-555555555555',
      agentId: 'agent_test_001',
      mandateId: '7f3d2a1b-9c8e-4f5d-a6b7-c8d9e0f1a2b3',
      amountCents: 5000,
      currency: 'EUR',
      vendorId: 'aws',
      nonce: 'test_nonce',
      ttlSeconds: 300,
    });

    expect(fields).toEqual({
      intent_id: '11111111-2222-3333-4444-555555555555',
      agent_id: 'agent_test_001',
      mandate_id: '7f3d2a1b-9c8e-4f5d-a6b7-c8d9e0f1a2b3',
      amount_cents: 5000,
      currency: 'EUR',
      vendor_id: 'aws',
      nonce: 'test_nonce',
      ttl_seconds: 300,
    });
  });

  it('includes payment_instruction when provided', () => {
    const fields = buildSignedFields({
      intentId: 'id',
      agentId: 'agent',
      mandateId: 'mandate',
      amountCents: 100,
      currency: 'EUR',
      vendorId: 'aws',
      nonce: 'nonce',
      ttlSeconds: 300,
      paymentInstruction: { recipientIban: 'DE89370400440532013000' },
    });

    expect(fields.payment_instruction).toEqual({
      recipient_iban: 'DE89370400440532013000',
    });
  });

  it('omits payment_instruction when null', () => {
    const fields = buildSignedFields({
      intentId: 'id',
      agentId: 'agent',
      mandateId: 'mandate',
      amountCents: 100,
      currency: 'EUR',
      vendorId: 'aws',
      nonce: 'nonce',
      ttlSeconds: 300,
      paymentInstruction: null,
    });

    expect('payment_instruction' in fields).toBe(false);
  });

  it('includes metadata when non-empty', () => {
    const fields = buildSignedFields({
      intentId: 'id',
      agentId: 'agent',
      mandateId: 'mandate',
      amountCents: 100,
      currency: 'EUR',
      vendorId: 'aws',
      nonce: 'nonce',
      ttlSeconds: 300,
      metadata: { key: 'value' },
    });

    expect(fields.metadata).toEqual({ key: 'value' });
  });
});
