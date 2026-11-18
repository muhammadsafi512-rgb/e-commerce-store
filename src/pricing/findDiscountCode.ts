import type { Payload } from 'payload'

import { normalizeDiscountCode } from '../utilities/normalizeDiscountCode'
import { DISCOUNT_CODES_SLUG } from './constants'

/**
 * Looks a discount code up by what the customer typed.
 *
 * Returns the raw document, or `null` when the input is empty or no code matches.
 * It does NOT check whether the code is usable: pass the result to
 * `evaluateDiscountCode`. Real failures (database down) are rethrown, never
 * reported as "not found", so an outage cannot look like a bad code.
 *
 * Read-only, and meant for the checkout wrapper, which runs BEFORE the customer
 * pays. Do not call it from settlement.
 */
export const findDiscountCode = async (
  payload: Pick<Payload, 'find'>,
  rawCode: unknown,
): Promise<Record<string, unknown> | null> => {
  const code = normalizeDiscountCode(rawCode)
  if (!code) return null

  const result = await payload.find({
    collection: DISCOUNT_CODES_SLUG,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: { code: { equals: code } },
  })

  const doc: unknown = result.docs[0]
  return typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : null
}