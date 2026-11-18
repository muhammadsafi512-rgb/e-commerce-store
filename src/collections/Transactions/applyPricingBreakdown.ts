import type { CollectionBeforeChangeHook } from 'payload'

import { PRICING_CONTEXT_KEY, readPricingBreakdown } from '../../pricing/pricingBreakdown'

/**
 * Copies the server-computed price breakdown onto a new transaction.
 *
 * The checkout wrapper puts the breakdown in `req.context`. The Stripe adapter then
 * creates the transaction with that same `req`, so this hook sees it and the fields
 * are saved in the SAME write as the create: there is no second update and no moment
 * where a charged transaction lacks its breakdown.
 *
 * Safety:
 * - Create only. Settlement updates the transaction (status, order), and this hook
 *   does nothing then.
 * - Writes only `subtotal`, `discountCode`, `discountTotal` and `shippingTotal`.
 *   It never touches `items` (settlement compares it with the Stripe metadata) or
 *   `amount`.
 * - The breakdown is saved only if it adds up AND its total equals the transaction
 *   amount. Otherwise nothing is saved and a warning is logged.
 * - It never throws. A problem here must not block a checkout.
 */
export const applyPricingBreakdown: CollectionBeforeChangeHook = ({
  context,
  data,
  operation,
  req,
}) => {
  if (operation !== 'create') return data

  try {
    const breakdown = readPricingBreakdown(context)

    if (!breakdown) {
      if (context && context[PRICING_CONTEXT_KEY] !== undefined) {
        req.payload.logger.warn({
          msg: 'Pricing breakdown on the request is invalid; not saved on the transaction',
        })
      }
      return data
    }

    if (data?.amount !== breakdown.total) {
      req.payload.logger.warn({
        amount: data?.amount,
        msg: 'Pricing breakdown total does not match the transaction amount; not saved',
        total: breakdown.total,
      })
      return data
    }

    return {
      ...data,
      discountCode: breakdown.discountCode,
      discountTotal: breakdown.discountTotal,
      shippingTotal: breakdown.shippingTotal,
      subtotal: breakdown.subtotal,
    }
  } catch (error) {
    try {
      req.payload.logger.error({ err: error, msg: 'Could not apply the pricing breakdown' })
    } catch {
      // Logging must not throw either.
    }
    return data
  }
}