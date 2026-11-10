/**
 * Normalises a SKU before it is validated and saved.
 *
 * - trims whitespace and uppercases, so `ab-1 ` and `AB-1` cannot both exist
 *   (Postgres unique indexes are case-sensitive)
 * - turns an empty value into `null`, so the optional field stays empty
 *   instead of saving `''`; several `''` values would collide on the unique
 *   index, while several `null` values do not
 */
export const normalizeSku = (value: unknown): string | null => {
  if (typeof value !== 'string') return null

  const sku = value.trim().toUpperCase()

  return sku.length > 0 ? sku : null
}