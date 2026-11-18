/**
 * The server-computed price breakdown of one checkout attempt.
 *
 * The checkout wrapper (`withCheckoutValidation`) works it out BEFORE the customer
 * pays and hands it to the `transactions` create hook through `req.context`, so it
 * is saved in the same write that creates the transaction. It is never read from
 * anything the browser sends.
 *
 * All amounts are integer cents. Always: subtotal - discountTotal + shippingTotal = total.
 */
export type PricingBreakdown = {
  /** Normalised code that was applied, or `null` when there was none. */
  discountCode: null | string
  discountTotal: number
  shippingTotal: number
  /** Items total from current database prices, before discount and shipping. */
  subtotal: number
  /** What the customer is charged. */
  total: number
}

/** Key in `req.context` that carries the breakdown from the wrapper to the hook. */
export const PRICING_CONTEXT_KEY = 'cartwrightPricing' as const

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export const buildPricingBreakdown = ({
  discountCode,
  discountTotal,
  shippingTotal,
  subtotal,
}: Omit<PricingBreakdown, 'total'>): PricingBreakdown => ({
  discountCode,
  discountTotal,
  shippingTotal,
  subtotal,
  total: subtotal - discountTotal + shippingTotal,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Shared checks. A breakdown that is not internally consistent is never used. */
const parseBreakdown = (raw: Record<string, unknown>): null | PricingBreakdown => {
  const { discountCode, discountTotal, shippingTotal, subtotal, total } = raw

  if (!isPositiveInt(subtotal) || !isPositiveInt(total)) return null
  if (!isNonNegativeInt(discountTotal) || !isNonNegativeInt(shippingTotal)) return null

  if (discountCode !== null && (typeof discountCode !== 'string' || discountCode === '')) {
    return null
  }
  // An amount taken off needs a code that explains it.
  if (discountCode === null && discountTotal !== 0) return null
  if (discountTotal > subtotal) return null
  if (subtotal - discountTotal + shippingTotal !== total) return null

  return { discountCode, discountTotal, shippingTotal, subtotal, total }
}

/**
 * Reads the breakdown back out of `req.context`, or returns `null` if it is missing
 * or does not add up. A breakdown that is not internally consistent is never saved:
 * no breakdown is better than a wrong one.
 */
export const readPricingBreakdown = (context: unknown): null | PricingBreakdown => {
  if (!isRecord(context)) return null

  const raw = context[PRICING_CONTEXT_KEY]
  if (!isRecord(raw)) return null

  return parseBreakdown(raw)
}

/**
 * Reads the breakdown that `applyPricingBreakdown` saved on a transaction, or `null`
 * if the transaction has none (created before step 8b, or outside checkout) or it does
 * not add up. `transaction.amount` is the total, so a stored breakdown that disagrees
 * with the amount that was actually charged is rejected.
 */
export const readTransactionBreakdown = (transaction: unknown): null | PricingBreakdown => {
  if (!isRecord(transaction)) return null

  return parseBreakdown({
    discountCode: transaction.discountCode ?? null,
    discountTotal: transaction.discountTotal,
    shippingTotal: transaction.shippingTotal,
    subtotal: transaction.subtotal,
    total: transaction.amount,
  })
}