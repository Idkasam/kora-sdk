/**
 * KoraAuto — scan-mode SDK for spend observation (no signing, no enforcement).
 *
 * Emits spend-intent signals to Kora's observation endpoint. Observations are
 * used by admins to discover candidate agents for delegation.
 *
 * Errors are logged to stderr (prefix KORA_SCAN_WARN), never thrown.
 */

const DEFAULT_BASE_URL = 'https://api.koraprotocol.com';

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

export class KoraAuto {
  private scanToken: string;
  private baseUrl: string;
  private warnThrottle: Map<string, number> = new Map();

  constructor(config: KoraAutoConfig) {
    this.scanToken = config.scanToken;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  async observe(params: ObserveParams): Promise<{ status: string }> {
    const svc =
      params.serviceName ??
      process.env.KORA_SERVICE_NAME ??
      (await import('node:os')).hostname();
    const env =
      params.environment ?? process.env.KORA_ENVIRONMENT ?? 'unknown';
    const rtId =
      params.runtimeId ?? process.env.KORA_RUNTIME_ID ?? 'unknown';

    const body: Record<string, unknown> = {
      signal_type: 'EXPLICIT_SPEND_INTENT',
      observed_at: new Date().toISOString(),
      runtime: {
        service_name: svc,
        environment: env,
        runtime_id: rtId,
        ...(params.repoHint != null ? { repo_hint: params.repoHint } : {}),
      },
      spend: {
        vendor_id: params.vendor,
        ...(params.amountCents != null ? { amount_cents: params.amountCents } : {}),
        ...(params.currency != null ? { currency: params.currency } : {}),
        ...(params.reason != null ? { reason: params.reason } : {}),
      },
    };

    try {
      const resp = await fetch(`${this.baseUrl}/v1/auto/observe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Scan-Token': this.scanToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        this.warn(params.vendor, svc, env, rtId, `http_${resp.status}`);
        return { status: 'error' };
      }

      return (await resp.json()) as { status: string };
    } catch (err) {
      const errorReason =
        err instanceof Error ? err.constructor.name.toLowerCase() : 'unknown';
      this.warn(params.vendor, svc, env, rtId, errorReason);
      return { status: 'error' };
    }
  }

  private warn(
    vendor: string,
    service: string,
    env: string,
    runtimeId: string,
    error: string,
  ): void {
    const key = `${vendor}:${error}`;
    const now = Date.now();
    const last = this.warnThrottle.get(key) ?? 0;
    if (now - last < 60_000) return;
    this.warnThrottle.set(key, now);

    process.stderr.write(
      `KORA_SCAN_WARN vendor=${vendor} service=${service} env=${env} runtime=${runtimeId} error=${error}\n`,
    );
  }
}
