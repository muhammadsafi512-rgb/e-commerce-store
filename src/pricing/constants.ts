/** Slug of the discount codes collection. */
export const DISCOUNT_CODES_SLUG = 'discount-codes' as const

/**
 * Stripe's minimum charge for USD, in cents. The store is USD only (see the
 * non-goals in brief.md), so one constant is enough. The final amount charged
 * (subtotal - discount + shipping) must never fall below it.
 */
export const STRIPE_MIN_CHARGE_CENTS = 50