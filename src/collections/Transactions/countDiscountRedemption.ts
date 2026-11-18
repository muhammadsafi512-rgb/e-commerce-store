import type { CollectionAfterChangeHook } from "payload";

import { DISCOUNT_CODES_SLUG } from "@/pricing/constants";

/**
 * Counts one redemption of a discount code when a payment is settled.
 *
 * Both settlement paths (the browser confirm step and the `payment_intent.succeeded`
 * webhook) end by setting the transaction to `succeeded`, so this one hook covers both.
 *
 * It runs once per transaction: only when the status BECOMES `succeeded`. A later edit of
 * a transaction that is already `succeeded` counts nothing, and neither does a retry that
 * finds the order already settled.
 *
 * Safety (it runs after the customer has paid):
 * - It never throws. Errors are logged and settlement carries on.
 * - It writes only `redemptions` on the discount code. It does not touch the order, the
 *   transaction, stock or `items`.
 * - The read and the write pass `req`, so they join the settlement database transaction
 *   (decision #25): if settlement rolls back, the count rolls back with it, and a webhook
 *   retry cannot count twice.
 * - The write is an atomic `$inc` through `payload.db.updateOne`, like the plugin's own
 *   stock decrement. It runs no hooks and is not blocked by the field's `update: nobody`
 *   access, which is how `redemptions` stays unchangeable through the API.
 * - There is no cap here. Checkout already checked `maxRedemptions`; two buyers racing for
 *   the last redemption can both succeed (decision #25).
 * - Residual risk, accepted (same as #35): if the database itself rejected one of these
 *   statements, Postgres would abort the whole settlement transaction even though the error
 *   is caught here. They are a plain read and one update of a column added in step 8a, so
 *   this only happens if the schema is missing (decision #36).
 */

export const countDiscountRedemption: CollectionAfterChangeHook = async ({
    doc, operation, previousDoc, req,
}) => {
    if (operation !== 'update') return doc
    if (doc?.status !== 'succeeded' || previousDoc?.status === 'succeeded') return doc

    try {
        const code = typeof doc.discountCode === 'string' ? doc.discountCode.trim() : ''
        if (code === '') return doc

        const found = await req.payload.find({
            collection: DISCOUNT_CODES_SLUG,
            depth: 0,
            limit:1,
            overrideAccess: true,
            pagination: false,
            req,
            where: { code: { equals: code } },
        })
        const record = found.docs[0]

        if (!record) {
            //For example an admin deleted the code after the customer started checkout.
            req.payload.logger.warn({
                code: code.slice(0, 64),
                msg: 'Discount code of a settled transaction no longer exists; redemption not counted',
                transactionID: doc.id,
            })
            return doc
        }

        await req.payload.db.updateOne({
            id: record.id,
            collection: DISCOUNT_CODES_SLUG,
            data: { redemptions: { $inc: 1 } } as never,
            req,
        })
    } catch (error) {
        try {

            req.payload.logger.error({
                err: error,
                msg: 'Could not count the discount code redemption',
                transactionID: doc?.id,
            })
        } catch {
            //Logging must not throw either.
        }
    }
    return doc
}