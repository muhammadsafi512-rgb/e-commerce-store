import type { PayloadRequest } from 'payload'

import { toID, type DocID } from '@/utilities/toID'

/**
 * Settles one paid transaction: claims it, creates the order, marks the cart purchased,
 * decrements stock and marks the transaction `succeeded`. It mirrors the plugin's own
 * `finalizeTransactionOrder` (v3.92.1, `endpoints/confirmOrder.ts`) step for step, because the
 * browser's confirm step and the webhook must converge on one order and one stock decrement.
 *
 * It must run inside a database transaction started by the caller (`req` carries it). The claim
 * is an atomic compare-and-set: only one caller can move the transaction from `pending` to
 * `processing`. On Postgres a second caller waits on the row lock until the first commits, then
 * finds nothing to claim, so it returns `{ settled: false }` and the order already exists.
 *
 * Settlement ends by updating the transaction to `succeeded`, which fires our
 * `flagOversoldOrder` hook (step 6a) exactly as on the browser path.
 */

const TRANSACTIONS = 'transactions'
const ORDERS = 'orders'
const CARTS = 'carts'
const PRODUCTS = 'products'
const VARIANTS = 'variants'

export type SettleResult = { orderID: DocID; settled: true } | { settled: false }

type AnyRecord = Record<string, unknown>

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const decrementInventory = async (req: PayloadRequest, items: unknown): Promise<void> => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Inventory transaction items are missing or invalid.')
  }

  for (const item of items) {
    if (
      !isRecord(item) ||
      typeof item.quantity !== 'number' ||
      !Number.isFinite(item.quantity) ||
      item.quantity <= 0
    ) {
      throw new Error('Inventory item quantity is missing or invalid.')
    }

    const variantID = toID(item.variant)
    const id = variantID ?? toID(item.product)

    if (id === undefined) throw new Error('Inventory item target is missing or invalid.')

    const updated = await req.payload.db.updateOne({
      id,
      collection: variantID !== undefined ? VARIANTS : PRODUCTS,
      data: { inventory: { $inc: item.quantity * -1 } } as never,
      req,
    })

    if (!updated) throw new Error('Inventory item could not be updated.')
  }
}

export const settleTransaction = async ({
  cartID,
  orderData,
  req,
  transactionID,
}: {
  cartID: DocID
  orderData: AnyRecord
  req: PayloadRequest
  transactionID: DocID
}): Promise<SettleResult> => {
  const payload = req.payload

  const claimed = await payload.db.updateOne({
    collection: TRANSACTIONS,
    data: { status: 'processing' } as never,
    options: { atomic: true },
    req,
    where: {
      and: [
        { id: { equals: transactionID } },
        { status: { equals: 'pending' } },
        { order: { exists: false } },
      ],
    },
  })

  // Lost the claim: another request settled (or is settling) this transaction.
  if (!claimed) return { settled: false }

  const transaction = (await payload.findByID({
    id: transactionID,
    collection: TRANSACTIONS,
    depth: 0,
    req,
  })) as unknown as AnyRecord | null

  if (!transaction || String(transaction.id) !== String(transactionID) || transaction.status !== 'processing') {
    throw new Error('Claimed transaction could not be loaded for settlement.')
  }

  const referenced = await payload.find({
    collection: ORDERS,
    depth: 0,
    limit: 1,
    pagination: false,
    req,
    where: { transactions: { equals: transactionID } },
  })

  if (referenced.totalDocs !== 0 || referenced.docs.length !== 0) {
    throw new Error('An order already references the claimed transaction.')
  }

  const order = (await payload.create({
    collection: ORDERS,
    data: { ...orderData, transactions: [transactionID] } as never,
    req,
  })) as unknown as AnyRecord

  const orderID = toID(order.id)
  if (orderID === undefined) throw new Error('order ID is missing or invalid.')

  await payload.update({
    id: cartID,
    collection: CARTS,
    data: { purchasedAt: new Date().toISOString() } as never,
    req,
  })

  await decrementInventory(req, transaction.items)

  await payload.update({
    id: transactionID,
    collection: TRANSACTIONS,
    data: { order: orderID, status: 'succeeded' } as never,
    req,
  })

  return { orderID, settled: true }
}