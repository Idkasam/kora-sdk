import type { AuthorizationResult, DenialObject } from './types.js';

/** Base error class for Kora SDK errors. */
export class KoraError extends Error {
  /** Error code from the API (e.g. MISSING_SIGNATURE, RATE_LIMIT_EXCEEDED). */
  readonly code: string;
  /** HTTP status code. */
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'KoraError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Error thrown when an authorization is denied. Includes the full result and denial details. */
export class KoraDenialError extends KoraError {
  /** Denial object with message, hint, and actionable fields. */
  readonly denial: DenialObject | null;
  /** Full authorization result. */
  readonly result: AuthorizationResult;

  constructor(result: AuthorizationResult) {
    const msg = result.denial?.message ?? `Authorization denied: ${result.reasonCode}`;
    super(result.reasonCode, msg, 200);
    this.name = 'KoraDenialError';
    this.denial = result.denial;
    this.result = result;
  }
}
