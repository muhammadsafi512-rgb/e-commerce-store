import type { CollectionAfterChangeHook } from "payload";

import { toID, type DocID } from "@/utilities/toID";
import { attentionFields } from "../Orders/attentionFields";

/**
 * Flags an order for admin follow-up when settlement left any item with negative stock.
 *
 * Why this exists (decision #24): stock is checked before payment but decremented after,
 * and the plugin's atomic `$inc` has no floor. If two customers both pass the check for the
 * last unit and both pay, the second settlement takes stock to -1. The order must still be
 * created (the customer has paid), so we flag it instead of failing.
 *
 * Where it runs: the plugin's settlement does, in one database transaction: create order,
 * decrement stock, then update the transaction to `succeeded`. This hook fires on that last
 * update, so it sees stock AFTER the decrement, including the effect of a concurrent buyer
 * (the second decrement waits for the first to commit). Any settlement path that finishes by
 * setting the transaction to `succeeded` is covered, including the webhook planned in step 7.
 *
 * Safety rules (this runs inside payment settlement, after the customer has paid):
 * 1. It never throws. Any error is logged and the settlement carries on.
 * 2. It only reads stock and sets two fields on the order. It never changes the transaction,
 *    its items, the order's amount or status, or stock.
 * 3. It passes `req` so its reads see the stock this transaction just changed, and so its one
 *    write joins the same transaction as the order row it updates. The write uses the database
 *    adapter directly, like the plugin's own stock decrement, so it runs no hooks.
 * 4. It runs once, only when the transaction first becomes `succeeded`.
 */

export const flagOversoldOrder: CollectionAfterChangeHook = async ({
    doc,
    operation,
    previousDoc,
    req,
}) => {
    if (operation !== 'update') return doc
    if (doc?.status !== 'succeeded' || previousDoc?.status === 'succeeded') return doc

    try {
        const orderID = toID(doc.order)
        const items: unknown = doc.items

        if (orderID === undefined || !Array.isArray(items)) return doc

        const problems: string[] = []
        const checked = new Set<string>()

        for (const item of items) {
            const variantID = toID(item?.variant)
            const productID = toID(item?.product)
            const collection = variantID !== undefined ? 'variants' : 'products'
            const id: DocID | undefined = variantID ?? productID

            if (id === undefined) continue

            const key = `${collection}:${id}`
            if(checked.has(key)) continue
            checked.add(key)

            const target = (await req.payload.findByID({
                collection,
                id,
                depth: 0,
                req,
                select: { inventory: true } as never,
            })) as { inventory?: unknown } | null

            const inventory = target?.inventory

            if (typeof inventory === 'number' && inventory < 0) {
                problems.push(
                    `${collection === 'variants' ? 'Variant': 'Product'} ${id} is oversold: stock is now ${inventory}.`,
                )
            }
        }

        if (problems.length === 0 ) return doc

        await req.payload.db.updateOne({
            id: orderID,
            collection: 'orders',
            data: {
                attentionReason: problems.join('\n'),
                needsAttention: true,
            },
            req,
        })

        req.payload.logger.warn({
            msg: 'Order flagged for attention after settlement',
            orderID,
            problems,
        })
    } catch (error) {
        req.payload.logger.error({
            err: error,
            msg: 'Could not check the order for oversold items; the order itself was saved',
        })
    }

    return doc
    
}