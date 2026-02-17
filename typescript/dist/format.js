"use strict";
/**
 * Shared currency formatting utility.
 *
 * Used by both SDK message construction and MCP template rendering.
 * This MUST be the single implementation — do not duplicate.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatAmount = formatAmount;
const CURRENCY_SYMBOLS = {
    EUR: '\u20ac', // €
    USD: '$',
    GBP: '\u00a3', // £
    SEK: 'kr',
};
/**
 * Format an amount in cents as a human-readable currency string.
 *
 * Rules (spec A.4.1):
 * 1. Divide amount_cents by 100 to get major units
 * 2. Always show 2 decimal places
 * 3. Prefix with currency symbol: EUR→€, USD→$, GBP→£, SEK→kr
 * 4. Unknown currency → prefix with ISO code + space (e.g. "CHF 50.00")
 * 5. Use period as decimal separator (never comma)
 * 6. No thousands separators
 */
function formatAmount(amountCents, currency) {
    const major = amountCents / 100;
    const formatted = major.toFixed(2);
    const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
    if (symbol) {
        return `${symbol}${formatted}`;
    }
    return `${currency.toUpperCase()} ${formatted}`;
}
