import { STRIPE_MIN_CHARGE_CENTS } from './constants'
import { calculateShipping } from './calculateShipping'
import type { ShippingSettings } from './shippingSettings'

export type DiscountType = 'percent' | 'fixed'

export type DiscountRejectReason =
  | 'not_found'
  | 'invalid_definition'
  | 'inactive'
  | 'expired'
  | 'exhausted'
  | 'invalid_amount'
  | 'invalid_settings'
  | 'items_total_zero'
  | 'below_minimum'

export type EvaluateDiscountInput = {
  /** The raw `discount-codes` document from the database. Treated as untrusted. */
  record: unknown
  /** Cart subtotal in cents, recomputed from database prices. */
  subtotal: number
  /** Shipping settings from the `site-settings` and global. Shpping is worked out here,
   * on the subtotal AFTER the discount (decision #41), so a code can never earn free shipping
   * that the order would not have qualified for once paid for.
   */
  shippingSettings: ShippingSettings
  /** Injectable clock for tests. */
  now?: Date
}

export type EvaluateDiscountResult =
  | {
      ok: true
      code: string
      type: DiscountType
      value: number
      /** Cents taken off the subtotal. Always less than the subtotal(items never go to zero). */
      discountTotal: number
      /** Shipping in cents, decided on the subtotal after the discount. */
      shippingTotal: number
      /** Final amount to charge: subtotal - discountTotal + shippingTotal. */
      total: number
    }
  | { ok: false; reason: DiscountRejectReason }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Cents taken off `subtotal`. Percent discounts round DOWN (the customer never
 * gets more than the stated percent). Fixed discounts are capped at the subtotal.
 * Expects already-validated input; use `evaluateDiscountCode` as the entry point.
 */
export const computeDiscountTotal = (
  definition: { type: DiscountType; value: number },
  subtotal: number,
): number => {
  const raw =
    definition.type === 'percent'
      ? Math.floor((subtotal * definition.value) / 100)
      : definition.value
  return Math.min(raw, subtotal)
}

/**
 * Decides whether a discount code can be used for this cart and, if so, how
 * much it takes off and what shipping then costs. Pure: no database, no clock
 * unless `now` is omitted.
 *
 * Fails closed. Anything unexpected in the stored record (wrong type, 100%,
 * a bad date) or in the shipping settings rejects the code instead of guessing,
 * because this runs before the customer is charged and a rejected code only
 * costs a retry.
 *
 * Checks, in order: amounts -> record shape -> active -> expiry -> redemption
 * limit -> items must stay above zero -> shipping settings -> Stripe minimum on
 * the final total.
 *
 * A code that would take the items to zero is rejected even when shipping would
 * keep the total above the Stripe minimum (decision #41): the customer would be
 * paying shipping for free goods.
 */
export const evaluateDiscountCode = ({
  record,
  subtotal,
  shippingSettings,
  now = new Date(),
}: EvaluateDiscountInput): EvaluateDiscountResult => {
  if (!isPositiveInt(subtotal)) {
    return { ok: false, reason: 'invalid_amount' }
  }

  if (!isRecord(record)) return { ok: false, reason: 'invalid_definition' }

  const { code, type, value, active, expiresAt, maxRedemptions, redemptions } = record

  if (typeof code !== 'string' || code === '') {
    return { ok: false, reason: 'invalid_definition' }
  }
  if (type !== 'percent' && type !== 'fixed') {
    return { ok: false, reason: 'invalid_definition' }
  }
  // Both types: a whole, positive number (percent, or cents).
  if (!isPositiveInt(value)) return { ok: false, reason: 'invalid_definition' }
  // Percent is capped at 99. 100% is rejected on purpose (Stripe cannot charge zero).
  if (type === 'percent' && value > 99) return { ok: false, reason: 'invalid_definition' }

  let expiresAtMs: number | null = null
  if (expiresAt !== null && expiresAt !== undefined) {
    if (typeof expiresAt !== 'string' && typeof expiresAt !== 'number' && !(expiresAt instanceof Date)) {
      return { ok: false, reason: 'invalid_definition' }
    }
    expiresAtMs = new Date(expiresAt).getTime()
    if (Number.isNaN(expiresAtMs)) return { ok: false, reason: 'invalid_definition' }
  }

  if (maxRedemptions !== null && maxRedemptions !== undefined && !isPositiveInt(maxRedemptions)) {
    return { ok: false, reason: 'invalid_definition' }
  }
  // A missing counter counts as 0; a present but junk one (negative, 1.5, NaN) is rejected.
  const redeemed = redemptions === null || redemptions === undefined ? 0 : redemptions
  if (!isNonNegativeInt(redeemed)) return { ok: false, reason: 'invalid_definition' }

  if (active !== true) return { ok: false, reason: 'inactive' }

  if (expiresAtMs !== null && expiresAtMs <= now.getTime()) {
    return { ok: false, reason: 'expired' }
  }

  if (typeof maxRedemptions === 'number' && redeemed >= maxRedemptions) {
    return { ok: false, reason: 'exhausted' }
  }

  const discountTotal = computeDiscountTotal({ type, value }, subtotal)
  const discountedSubtotal = subtotal - discountTotal 

  // The items must still cost something. Only a fixed code can get here (percent is
  // capped at 99 and rounds down), and it is rejected for THIS cart: the same code
  // is fine on a bigger cart.

  if (discountedSubtotal <= 0) return { ok: false, reason: 'items_total_zero' }

  const shipping = calculateShipping({ discountedSubtotal, settings: shippingSettings })
  if (!shipping.ok) return { ok: false, reason: shipping.reason }

  const total = discountedSubtotal + shipping.shippingTotal

  if (total < STRIPE_MIN_CHARGE_CENTS) return { ok: false, reason: 'below_minimum' }

  return { ok: true, code, type, value, discountTotal, shippingTotal: shipping.shippingTotal, total }
}