# Kora TypeScript SDK

TypeScript SDK for the Kora authorization engine. Handles Ed25519 signing, nonce generation, canonical JSON serialization, idempotent retry, and offline seal verification.

## Installation

```bash
npm install @kora/sdk
```

**Requirements:** Node.js >= 18

## Quick Start

```typescript
import { Kora } from '@kora/sdk';

const kora = new Kora(process.env.KORA_AGENT_KEY!);

const auth = await kora.authorize({
  mandate: 'mandate_abc123',
  amount: 50_00,        // EUR 50.00
  currency: 'EUR',
  vendor: 'aws',
  category: 'compute',
});

if (auth.approved) {
  console.log(`Approved: ${auth.decisionId}`);
} else {
  console.log(`Denied: ${auth.reasonCode} — ${auth.denial.hint}`);
}
```

## Usage

### Initialize

```typescript
import { Kora } from '@kora/sdk';

const kora = new Kora('kora_agent_sk_...', {
  baseUrl: 'http://localhost:8000',  // default
  ttl: 300,         // default TTL in seconds
  maxRetries: 2,    // automatic idempotent retry on network error
});
```

### Authorize a Spend

```typescript
const auth = await kora.authorize({
  mandate: 'mandate_abc123',
  amount: 50_00,
  currency: 'EUR',
  vendor: 'aws',
  category: 'compute',  // required if mandate has category_allowlist
});
```

### Result Properties

```typescript
auth.approved        // boolean — true if APPROVED
auth.decision        // "APPROVED" | "DENIED"
auth.decisionId      // UUID of the authorization decision
auth.reasonCode      // "OK", "DAILY_LIMIT_EXCEEDED", etc.
auth.executable      // boolean — true if payment can be executed
auth.isValid         // boolean — true if TTL has not expired
auth.isEnforced      // boolean — true if enforcement_mode == "enforce"
auth.enforcementMode // "enforce" | "log_only"

// On denial:
auth.denial.hint            // Human-readable suggestion
auth.denial.actionable      // Machine-readable corrective values
auth.denial.failedCheck     // Which pipeline step failed

// On approval:
auth.limitsAfterApproval    // Remaining daily/monthly budget

// Evaluation trace:
auth.evaluationTrace.steps           // Array of pipeline step results
auth.evaluationTrace.totalDurationMs // Total evaluation time

// Notary seal:
auth.notarySeal.signature    // Ed25519 signature (base64)
auth.notarySeal.publicKeyId
auth.notarySeal.algorithm    // "Ed25519"

// Trace URL (for debugging denials):
auth.traceUrl  // e.g. http://localhost:8000/v1/authorizations/<id>/trace
```

### Handle Denials

```typescript
const auth = await kora.authorize({
  mandate: 'mandate_abc123',
  amount: 999_99,
  currency: 'EUR',
  vendor: 'aws',
});

if (!auth.approved) {
  console.log(`Denied: ${auth.reasonCode}`);
  console.log(`Hint: ${auth.denial.hint}`);

  if (auth.reasonCode === 'DAILY_LIMIT_EXCEEDED') {
    const available = auth.denial.actionable.available_cents;
    console.log(`Available budget: ${available} cents`);
  }

  if (auth.reasonCode === 'VENDOR_NOT_ALLOWED') {
    const allowed = auth.denial.actionable.allowed_vendors;
    console.log(`Allowed vendors: ${allowed}`);
  }

  console.log(`Trace: ${auth.traceUrl}`);
}
```

### Verify Notary Seal (Offline)

```typescript
const koraPublicKey = Buffer.from('...', 'base64');
const isValid = kora.verifySeal(auth, koraPublicKey);
console.log(`Seal valid: ${isValid}`);
```

### Simulation Mode

Test denial scenarios without affecting state. Requires an admin key with `simulation_access=true`.

```typescript
const auth = await kora.authorize({
  mandate: 'mandate_abc123',
  amount: 100,
  currency: 'EUR',
  vendor: 'aws',
}, {
  simulate: 'DAILY_LIMIT_EXCEEDED',
  adminKey: 'kora_admin_...',
});

console.log(auth.simulated);   // true
console.log(auth.decision);    // "DENIED"
console.log(auth.notarySeal);  // null (no seal in simulation)
```

### OpenAI Function Tool Schema

Generate an OpenAI-compatible function tool definition:

```typescript
const tool = kora.asTool('mandate_abc123');
// Returns:
// {
//   type: "function",
//   function: {
//     name: "kora_authorize_spend",
//     description: "Authorize a spend against a Kora mandate...",
//     parameters: {
//       type: "object",
//       properties: {
//         amount_cents: { type: "integer", description: "..." },
//         currency: { type: "string", description: "..." },
//         vendor_id: { type: "string", description: "..." },
//       },
//       required: ["amount_cents", "currency", "vendor_id"]
//     }
//   }
// }
```

Use with OpenAI:

```typescript
import OpenAI from 'openai';

const openai = new OpenAI();
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Buy $50 of AWS compute' }],
  tools: [kora.asTool('mandate_abc123')],
});
```

### Agent Self-Correction Pattern

```typescript
import { Kora } from '@kora/sdk';

const kora = new Kora(process.env.KORA_AGENT_KEY!);

// First attempt — too large
let auth = await kora.authorize({
  mandate: 'mandate_abc123',
  amount: 999_99,
  currency: 'EUR',
  vendor: 'aws',
});

if (!auth.approved && auth.reasonCode === 'DAILY_LIMIT_EXCEEDED') {
  const available = auth.denial.actionable.available_cents;
  console.log(`Budget available: ${available} cents, retrying...`);

  // Retry with corrected amount
  auth = await kora.authorize({
    mandate: 'mandate_abc123',
    amount: available,
    currency: 'EUR',
    vendor: 'aws',
  });
  console.log(`Second attempt: ${auth.decision}`);  // APPROVED
}
```

## API Reference

### `new Kora(keyString, options?)`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `keyString` | string | required | Agent secret key (`kora_agent_sk_...`) |
| `options.baseUrl` | string | `http://localhost:8000` | Kora API base URL |
| `options.ttl` | number | 300 | Default TTL for decisions (seconds) |
| `options.maxRetries` | number | 2 | Automatic retries on network error |

### `kora.authorize(params, options?) -> Promise<AuthorizationResult>`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `params.mandate` | string | yes | Mandate ID |
| `params.amount` | number | yes | Amount in cents |
| `params.currency` | string | yes | 3-letter currency code |
| `params.vendor` | string | yes | Vendor identifier |
| `params.category` | string | no | Spending category |
| `options.simulate` | string | no | Force denial reason code |
| `options.adminKey` | string | no | Admin key for simulation |

### `kora.verifySeal(result, publicKey) -> boolean`

Verify the Ed25519 notary seal offline.

### `kora.asTool(mandate, options?) -> object`

Generate OpenAI function tool schema.
