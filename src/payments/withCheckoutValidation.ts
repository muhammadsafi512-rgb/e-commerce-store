import type { PaymentAdapter } from '@payloadcms/plugin-ecommerce/types'

import { CheckoutValidationError, validateCheckoutCart } from './validateCheckoutCart'

/**
 * Wraps a payment adapter so `initiatePayment` first validates the cart against the
 * database (stock, price, published status, variant ownership) and charges the freshly
 * computed subtotal instead of the cart's stored one.
 *
 * Only `initiatePayment` is replaced. `confirmOrder`, webhook endpoints, the transactions
 * group, label and name are the original adapter's, so settlement is untouched.
 *
 * The cart items passed on are the original ones, so the PaymentIntent metadata snapshot
 * and `transactions.items` stay identical, which settlement requires.
 *
 * When validation fails the error is logged and re-thrown. The plugin's endpoint turns it
 * into a generic 500 "Error initiating payment." (decision #21), and no PaymentIntent or
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

    return adapter.initiatePayment({
      ...args,
      data: { ...data, cart: { ...data.cart, subtotal } },
    })
  },
})