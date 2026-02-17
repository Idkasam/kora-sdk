/**
 * Shared currency formatting utility.
 *
 * Used by both SDK message construction and MCP template rendering.
 * This MUST be the single implementation — do not duplicate.
 */
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
export declare function formatAmount(amountCents: number, currency: string): string;
