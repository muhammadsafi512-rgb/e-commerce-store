import type { CollectionBeforeChangeHook } from "payload";

import { readTransactionBreakdown } from "@/pricing/pricingBreakdown";

const TRANSACTIONS_SLUG = 'transactions' as const

const relationshipID = (value: unknown): null | number | string => {
    if (typeof value === 'number' || (typeof value === 'string' && value !== '')) return value
    if (typeof value === 'object' && value !== null && 'id' in value) {
        return relationshipID((value as { id: unknown}).id)
    }
    return null
}

/**
 * Copies the price breakdown from the order's transaction onto a new order.
 *
 * Settlement creates the order with `transactions: [transactionID]`. The transaction
 * already holds the breakdown, saved when the customer started checkout.
 *
 * This hook runs INSIDE payment settlement, after the customer has paid, so it must
 * never get in the way of the order being created:
 * - Create only. It does nothing on later updates.
 * - Fail-open: any problem is logged and the order is saved without a breakdown.
 * - The transaction is read WITHOUT `req`, so the read is outside the settlement
 *   database transaction and a failed read cannot abort it (same approach as
 *   `snapshotOrderItems`). The breakdown was committed long before, so nothing is missed.
 * - It writes only `subtotal`, `discountCode`, `discountTotal` and `shippingTotal` on
 *   the ORDER. It never changes `amount`, `items` or anything on the transaction.
 * - The breakdown is copied only if it adds up AND its total equals the order amount.
 *   No breakdown is better than a wrong one.
 * - A breakdown that is already on the data (seed script, admin) is left alone.
 */

export const copyPricingToOrder: CollectionBeforeChangeHook = async ({
    data, operation, req }) => {
        if (operation !== 'create') return data

        try{
            if (data?.subtotal !== undefined && data?.subtotal !== null)
        return data

            const transactions: unknown = data?.transactions
            const transactionID = relationshipID(Array.isArray(transactions) ? transactions[0] : null)

            if(transactionID === null) return data

            //Deliberately no `req`: see above.
            const transaction: unknown = await req.payload.findByID({
                id: transactionID,
                collection: TRANSACTIONS_SLUG,
                depth: 0,
                overrideAccess: true,
            })

            const breakdown = readTransactionBreakdown(transaction)
            //No breakdown: a transaction from before step 8b, or one made outside checkout.
            if(!breakdown) return data

            if(typeof data?.amount === 'number' && data.amount !== breakdown.total) {
                req.payload.logger.warn({
                    msg: 'Transaction breakdown total does not match the order amount; not copied to the order.',
                    orderAmount: data.amount,
                    total: breakdown.total,
                    transactionID,
                })
                return data
            }
            return{
                ...data,
                discountCode: breakdown.discountCode,
                discountTotal: breakdown.discountTotal,
                shippingTotal: breakdown.shippingTotal,
                subtotal: breakdown.subtotal,
            }
        } catch (error) {
            try {
                req.payload.logger.error({ err: error, msg: 'Could not copy the price breakdown to the order' })
            } catch {
                //Logging must not throw either.
            }
            return data
        }
    }