"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KoraDenialError = exports.KoraError = void 0;
/** Base error class for Kora SDK errors. */
class KoraError extends Error {
    /** Error code from the API (e.g. MISSING_SIGNATURE, RATE_LIMIT_EXCEEDED). */
    code;
    /** HTTP status code. */
    statusCode;
    constructor(code, message, statusCode) {
        super(message);
        this.name = 'KoraError';
        this.code = code;
        this.statusCode = statusCode;
    }
}
exports.KoraError = KoraError;
/** Error thrown when an authorization is denied. Includes the full result and denial details. */
class KoraDenialError extends KoraError {
    /** Denial object with message, hint, and actionable fields. */
    denial;
    /** Full authorization result. */
    result;
    constructor(result) {
        const msg = result.denial?.message ?? `Authorization denied: ${result.reasonCode}`;
        super(result.reasonCode, msg, 200);
        this.name = 'KoraDenialError';
        this.denial = result.denial;
        this.result = result;
    }
}
exports.KoraDenialError = KoraDenialError;
