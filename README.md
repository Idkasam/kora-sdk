# kora-sdk

**Deterministic authorization for AI agent spending. Python + TypeScript.**

```
pip install kora-sdk
```

```
npm install @kora-protocol/sdk
```

## Try it now — zero setup

No API keys. No server. No signup. Just install and run.

> Sandbox mode performs **authorization only**. No money moves. No bank details are used. No external systems are contacted.

### Python

```python
from kora import Kora

kora = Kora(sandbox=True)

result = kora.spend("aws", 5000, "EUR", "GPU provisioning")
print(result.approved)        # True
print(result.decision_id)     # sandbox_a1b2c3d4...

result = kora.spend("aws", 9999999, "EUR")
print(result.approved)        # False
print(result.reason_code)     # DAILY_LIMIT_EXCEEDED
print(result.retry_with)      # {'amount_cents': 995000}
```

### TypeScript

```typescript
import { Kora } from '@kora-protocol/sdk';

const kora = new Kora({ sandbox: true });

const result = await kora.spend({ vendor: 'aws', amountCents: 5000, currency: 'EUR' });
console.log(result.approved);     // true
console.log(result.decisionId);   // sandbox_a1b2c3d4...
```

Sandbox simulates the full authorization engine in-memory: daily limits (€10,000), monthly limits (€50,000), vendor allowlists, currency checks, and per-transaction caps. Every denial includes a `retry_with` hint so your agent can self-correct.

> `vendor` is an abstract identifier (e.g. `"aws"`, `"stripe"`, `"openai"`). Kora authorizes *who* an agent may spend with — payment routing happens later.

## Self-correcting agent pattern

This pattern lets agents adapt automatically to policy constraints instead of hard-failing.

```python
kora = Kora(sandbox=True)

# Spend most of the budget
kora.spend("aws", 800000, "EUR")  # €8,000 — approved

# Try to overspend
result = kora.spend("aws", 500000, "EUR")  # €5,000 — denied
print(result.retry_with)  # {'amount_cents': 200000}

# Agent self-corrects
result = kora.spend("aws", result.retry_with["amount_cents"], "EUR")
print(result.approved)  # True — €2,000
```

## Custom sandbox limits

```python
kora = Kora(
    sandbox=True,
    sandbox_config={
        "daily_limit_cents": 500000,      # €5,000/day
        "monthly_limit_cents": 2000000,   # €20,000/month
        "currency": "USD",
        "allowed_vendors": ["aws", "gcp"],
        "per_transaction_max_cents": 100000
    }
)
```

## Check budget

```python
budget = kora.check_budget()
print(f"Daily remaining: €{budget.daily.remaining_cents / 100:.2f}")
print(f"Monthly remaining: €{budget.monthly.remaining_cents / 100:.2f}")
print(f"Can spend: {budget.spend_allowed}")
```

## Environment variable activation

For tools like MCP servers or n8n nodes where you can't pass constructor args:

```bash
export KORA_SANDBOX=true
```

```python
kora = Kora()  # Detects KORA_SANDBOX=true, activates sandbox
```

> If `KORA_SANDBOX=true` is set, sandbox mode is always used, even if credentials are provided.

## Switch to production

When you're ready, add your credentials — everything else stays the same:

```python
kora = Kora(
    secret="kora_agent_sk_...",
    mandate="mandate_abc123"
)

result = kora.spend("aws", 5000, "EUR", "GPU provisioning")
```

```typescript
const kora = new Kora({
    secret: 'kora_agent_sk_...',
    mandate: 'mandate_abc123'
});
```

Every `spend()` call in production:
1. Builds a canonical JSON payload (sorted keys, deterministic)
2. Signs it with your agent's Ed25519 private key
3. Sends to the Kora server over HTTPS
4. Server runs a deterministic pipeline in a SERIALIZABLE transaction
5. Returns APPROVED or DENIED with a cryptographic seal

This makes every authorization decision auditable, replayable, and non-repudiable.

## Also available as

| Package | Description |
| --- | --- |
| [kora-mcp-server](https://github.com/Idkasam/kora-mcp-server) | MCP server — add Kora to Claude Desktop with zero code |
| [n8n-nodes-kora](https://github.com/Idkasam/n8n-nodes-kora) | n8n community node — visual workflow with two-output branching |

## Links

- **Website:** [koraprotocol.com](https://koraprotocol.com)
- **Developer docs:** [usekora.dev](https://usekora.dev)
- **PyPI:** [kora-sdk](https://pypi.org/project/kora-sdk/)
- **npm:** [@kora-protocol/sdk](https://www.npmjs.com/package/@kora-protocol/sdk)
- **Patent:** PCT/EP2025/053553

## License

Apache 2.0
