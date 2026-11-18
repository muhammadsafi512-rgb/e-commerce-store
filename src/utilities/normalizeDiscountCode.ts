/**
 * Canonical form of a discount code: trimmed and uppercase. Empty or non-string
 * input becomes `null`.
 *
 * Used in two places so they can never disagree:
 * - a `beforeValidate` field hook on `discount-codes.code` (what gets stored)
 * - the checkout lookup (what the customer typed)
 *
 * Postgres unique indexes are case-sensitive, so without this `summer10` and
 * `SUMMER10` would both be allowed (same reasoning as `normalizeSku`).
 */
export const normalizeDiscountCode = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  return normalized === '' ? null : normalized
}