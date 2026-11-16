import { commitTransaction, initTransaction, killTransaction } from 'payload'
import type { stripeAdapter } from '@payloadcms/plugin-ecommerce/payments/stripe'

import { createPaymentIntentSucceededHandler } from './settlement/paymentIntentSucceded'

// The plugin does not export its webhook types, so derive them from the adapter's argument.
type StripeWebhooks = NonNullable<Parameters<typeof stripeAdapter>[0]['webhooks']>

/**
 * Webhook handlers for `stripeAdapter({ webhooks })`. The plugin verifies the Stripe signature
 * before calling them. See `settlement/paymentIntentSucceeded.ts` for behaviour.
 */
export const stripeWebhooks: StripeWebhooks = {
  'payment_intent.succeeded': createPaymentIntentSucceededHandler({
    commitTransaction,
    initTransaction,
    killTransaction,
  }) as StripeWebhooks[string],
}