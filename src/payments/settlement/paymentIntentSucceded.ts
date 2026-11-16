import type { PayloadRequest } from 'payload'

import { toID } from '@/utilities/toID'

import { normalizeEmail } from './normalize'
import { settleTransaction } from './settleTransaction'
import { validateWebhookSettlement } from './validateWebhooksettlement'

/**
 * Stripe `payment_intent.succeeded` handler. It is the safety net for customers who pay and then
 * close the tab before the browser's confirm step runs: it creates the same order, with the same
 * claim and stock decrement, and is harmless when the browser path already did the work.
 *
 * Behaviour:
 * - Returns normally (the plugin answers 200) when the event is not for one of our transactions,
 *   or the transaction is already settled, or another request won the claim.
 * - Throws (the plugin answers 500, so Stripe retries later) when something is wrong or
 *   transient: Stripe unreachable, mismatch between Stripe and our transaction, database error.
 *   Nothing is written in those cases, because settlement is one database transaction that is
 *   rolled back, and the validation runs before it starts. A persistent failure also shows up as a
 *   failing delivery in the Stripe dashboard.
 *
 * The Stripe object is re-fetched instead of trusting the event body, like the browser path.
 */

type TransactionDeps = {
  commitTransaction: (req: PayloadRequest) => Promise<void>
  initTransaction: (req: PayloadRequest) => Promise<boolean>
  killTransaction: (req: PayloadRequest) => Promise<void>
}

type AnyRecord = Record<string, unknown>

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseMetadata = (name: string, value: unknown, required: boolean): unknown => {
  if (value === undefined && !required) return undefined

  if (typeof value !== 'string' || !value) throw new Error(`${name} metadata is missing or invalid`)

  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${name} metadata is missing or invalid`)
  }
}

export const createPaymentIntentSucceededHandler =
  (deps: TransactionDeps) =>
  async ({
    event,
    req,
    stripe,
  }: {
    event: { data: { object: unknown } }
    req: PayloadRequest
    stripe: { paymentIntents: { retrieve: (id: string) => Promise<unknown> } }
  }): Promise<void> => {
    const payload = req.payload
    const eventObject = event.data.object
    const paymentIntentID = isRecord(eventObject) ? eventObject.id : undefined

    if (typeof paymentIntentID !== 'string' || !paymentIntentID) {
      payload.logger.error({ msg: 'payment_intent.succeeded event has no PaymentIntent ID' })

      return
    }

    const found = await payload.find({
      collection: 'transactions',
      depth: 0,
      limit: 2,
      pagination: false,
      where: { 'stripe.paymentIntentID': { equals: paymentIntentID } },
    })

    if (found.totalDocs === 0) {
      payload.logger.warn({ msg: 'Webhook: no transaction for this PaymentIntent; ignoring', paymentIntentID })

      return
    }

    if (found.totalDocs !== 1) {
      throw new Error(`Expected exactly one transaction for PaymentIntent ${paymentIntentID}`)
    }

    const transaction = found.docs[0] as unknown as AnyRecord
    const transactionID = toID(transaction.id)

    if (transactionID === undefined) throw new Error('Transaction ID is missing or invalid')

    if (transaction.status === 'succeeded') {
      payload.logger.info({ msg: 'Webhook: transaction already settled; nothing to do', paymentIntentID })

      return
    }

    if (transaction.status !== 'pending') {
      throw new Error(
        `Transaction ${transactionID} has status "${String(transaction.status)}" but PaymentIntent ${paymentIntentID} succeeded`,
      )
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentID)

    if (!isRecord(paymentIntent)) throw new Error('Stripe returned no PaymentIntent')

    const metadata = isRecord(paymentIntent.metadata) ? paymentIntent.metadata : {}
    const cartItemsSnapshot = parseMetadata('cartItemsSnapshot', metadata.cartItemsSnapshot, true)
    const shippingAddress = parseMetadata('shippingAddress', metadata.shippingAddress, false)

    validateWebhookSettlement({ cartItemsSnapshot, paymentIntent, transaction })

    const cartID = toID(transaction.cart)
    if (cartID === undefined) throw new Error('Transaction has no cart')

    const customerID = toID(transaction.customer)

    // Same order data as the plugin's Stripe `confirmOrder`, with the purchaser taken from the
    // transaction because the webhook has no logged-in user.
    const orderData: AnyRecord = {
      amount: transaction.amount,
      currency: transaction.currency,
      ...(customerID !== undefined
        ? { customer: customerID }
        : { customerEmail: normalizeEmail(transaction.customerEmail) }),
      items: cartItemsSnapshot,
      shippingAddress: isRecord(shippingAddress) ? shippingAddress : undefined,
      status: 'processing',
    }

    const shouldCommit = await deps.initTransaction(req)

    try {
      const result = await settleTransaction({ cartID, orderData, req, transactionID })

      if (shouldCommit) await deps.commitTransaction(req)

      payload.logger.info(
        result.settled
          ? { msg: 'Webhook: order created', orderID: result.orderID, paymentIntentID }
          : { msg: 'Webhook: another request already settled this transaction', paymentIntentID },
      )
    } catch (error) {
      if (shouldCommit) await deps.killTransaction(req)

      payload.logger.error({ err: error, msg: 'Webhook: settlement failed; Stripe will retry', paymentIntentID })

      throw error
    }
  }