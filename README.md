# kora-sdk

**Deterministic authorization for AI agent spending. Python + TypeScript.**

```bash
pip install kora-sdk
```

```python
from kora import Kora

kora = Kora("kora_agent_sk_...", mandate="mandate_abc123")
result = kora.spend(vendor="openai", amount_cents=5000, currency="USD")
print("approved" if result.approved else f"denied: {result.denial.reason_code}")
```

## What it does

Every `spend()` call:
1. Builds a canonical JSON payload (sorted keys, deterministic)
2. Signs it with your agent's Ed25519 private key
3. Sends to the Kora server over HTTPS
4. Server runs 14-step deterministic pipeline in a SERIALIZABLE transaction
5. Returns APPROVED or DENIED with a cryptographic seal

One secret. One line. Done.

## TypeScript

```bash
npm install @kora-protocol/sdk
```

```typescript
import { Kora } from '@kora-protocol/sdk';

const kora = new Kora({ secret: 'kora_agent_sk_...', mandate: 'mandate_abc123' });
const result = await kora.spend({ vendor: 'openai', amountCents: 5000, currency: 'USD' });
```

## Check budget

```python
budget = kora.check_budget()
print(f"Daily remaining: {budget.daily.remaining_cents / 100:.2f} {budget.currency}")
print(f"Can spend: {budget.spend_allowed}")
```

## Self-correcting agent

```python
result = kora.spend(vendor="aws", amount_cents=50000, currency="EUR")

if not result.approved:
    budget = kora.check_budget()
    if budget.daily.remaining_cents > 0:
        result = kora.spend(
            vendor="aws",
            amount_cents=budget.daily.remaining_cents,
            currency="EUR",
            reason="Auto-reduced after budget check"
        )
```

## Also available as

| Package | Description |
|---|---|
| [kora-mcp-server](https://github.com/Idkasam/kora-mcp-server) | MCP server — add Kora to Claude Desktop with zero code |
| [n8n-nodes-kora](https://github.com/Idkasam/n8n-nodes-kora) | n8n community node — visual workflow with two-output branching |

## Links

- **Website:** [koraprotocol.com](https://koraprotocol.com)
- **PyPI:** [kora-sdk](https://pypi.org/project/kora-sdk/)
- **npm:** [@kora-protocol/sdk](https://www.npmjs.com/package/@kora-protocol/sdk)
- **Patent:** PCT/EP2025/053553

## License

Apache 2.0
