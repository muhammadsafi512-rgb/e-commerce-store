import type { PaymentAdapter } from '@payloadcms/plugin-ecommerce/types'

import { evaluateDiscountCode } from '../pricing/evaluateDiscountCode'
import { findDiscountCode } from '../pricing/findDiscountCode'
import { PRICING_CONTEXT_KEY, buildPricingBreakdown } from '../pricing/pricingBreakdown'
import { normalizeDiscountCode } from '../utilities/normalizeDiscountCode'
import { CheckoutValidationError, validateCheckoutCart } from './validateCheckoutCart'

/** Code the checkout page looks for to show a clear message (see CheckoutPage.tsx). */
export const DISCOUNT_REJECTED_CODE = 'DiscountCodeRejected'

/**
 * One message for every rejection reason (not found, expired, used up...), so the
 * response cannot be used to find out which codes exist. The real reason is only
 * in the server log.
 */
export const DISCOUNT_REJECTED_MESSAGE = "This discount code isn't valid for this order."

/** Shipping is added in step 9. Until then every order ships for 0 cents. */
const SHIPPING_TOTAL_CENTS = 0

/**
 * A rejected code is answered with HTTP 200 and an `error` field instead of a throw.
 * The plugin's endpoint turns any throw into a generic 500 "Error initiating payment.",
 * but its browser client rethrows `responseData.error` as the error message, which the
 * checkout page can read (verified in plugin-ecommerce 3.92.1, re-check on upgrades).
 * Nothing has been charged or created at this point.
 */
const discountRejected = () => ({
  error: JSON.stringify({
    cause: { code: DISCOUNT_REJECTED_CODE },
    message: DISCOUNT_REJECTED_MESSAGE,
  }),
  message: DISCOUNT_REJECTED_MESSAGE,
})

/**
 * Wraps a payment adapter so `initiatePayment` first validates the cart against the
 * database (stock, price, published status, variant ownership), applies a discount code
 * if the customer typed one, and charges the freshly computed total instead of the
 * cart's stored subtotal.
 *
 * Only `initiatePayment` is replaced. `confirmOrder`, webhook endpoints, the transactions
 * group, label and name are the original adapter's, so settlement is untouched.
 *
 * The cart items passed on are the original ones, so the PaymentIntent metadata snapshot
 * and `transactions.items` stay identical, which settlement requires.
 *
 * Discount codes (decision #38):
 * - The code is read from `req.data.discountCode` (the plugin's endpoint drops extra
 *   client fields from `data`). Only the code text is taken from the browser. Amounts
 *   are always computed here from database prices and the stored code definition.
 * - A rejected code returns a clear error and creates no PaymentIntent or transaction.
 * - The breakdown goes into `req.context` so the `transactions` create hook can save
 *   it in the same write that creates the transaction.
 *
 * When cart validation fails the error is logged and re-thrown. The plugin's endpoint turns
 * it into a generic 500 "Error initiating payment." (decision #21), and no PaymentIntent or
 * transaction is created.
 */
export const withCheckoutValidation = (adapter: PaymentAdapter): PaymentAdapter => ({
  ...adapter,
  initiatePayment: async (args) => {
    const { data, req } = args

    let subtotal: number

    try {
      ;({ subtotal } = await validateCheckoutCart({
        currency: data.currency,
        items: data.cart?.items,
        payload: req.payload,
      }))
    } catch (error) {
      if (error instanceof CheckoutValidationError) {
        req.payload.logger.warn({
          cartID: data.cart?.id,
          msg: `Checkout blocked: ${error.message}`,
        })
      }

      throw error
    }

    if (subtotal !== data.cart.subtotal) {
      req.payload.logger.warn({
        cartID: data.cart.id,
        cartSubtotal: data.cart.subtotal,
        msg: 'Cart subtotal differs from current database prices; charging the database total',
        subtotal,
      })
    }

    const rawCode: unknown = req.data?.discountCode
    const typedCode = normalizeDiscountCode(rawCode)

    // A code that was sent but is not text (a number, an object...) is refused, never
    // ignored: a client that sent a code must not be silently charged full price.
    // An empty or blank string is just "no code".
    if (
      typedCode === null &&
      rawCode !== undefined &&
      rawCode !== null &&
      typeof rawCode !== 'string'
    ) {
      req.payload.logger.warn({
        cartID: data.cart.id,
        msg: 'Discount code rejected: invalid_input',
      })

      return discountRejected()
    }

    let discount: { code: string; discountTotal: number } | null = null

    if (typedCode !== null) {
      // Real failures (for example the database being down) are thrown, not reported
      // as "code not found". Nothing has been charged yet, so a throw is safe.
      const record = await findDiscountCode(req.payload, rawCode)

      const result = record
        ? evaluateDiscountCode({ record, shippingTotal: SHIPPING_TOTAL_CENTS, subtotal })
        : ({ ok: false, reason: 'not_found' } as const)

      if (!result.ok) {
        req.payload.logger.warn({
          cartID: data.cart.id,
          code: typedCode.slice(0, 64),
          msg: `Discount code rejected: ${result.reason}`,
        })

        return discountRejected()
      }

      discount = { code: result.code, discountTotal: result.discountTotal }
    }

    const breakdown = buildPricingBreakdown({
      discountCode: discount?.code ?? null,
      discountTotal: discount?.discountTotal ?? 0,
      shippingTotal: SHIPPING_TOTAL_CENTS,
      subtotal,
    })

    // Read by the `transactions` create hook (applyPricingBreakdown) through the same `req`.
    req.context = { ...req.context, [PRICING_CONTEXT_KEY]: breakdown }

    const response = await adapter.initiatePayment({
      ...args,
      data: { ...data, cart: { ...data.cart, subtotal: breakdown.total } },
    })

    // The page shows the breakdown only when a code was applied. Without a code the
    // adapter's response is returned exactly as it was.
    return discount ? { ...response, pricing: breakdown } : response
  },
})