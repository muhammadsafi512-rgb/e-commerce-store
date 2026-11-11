import type { CollectionBeforeChangeHook, Payload } from 'payload'

/**
 * Freezes title, SKU and unit price onto each order line when an order is
 * created, so later edits or deletions of products and variants do not change
 * old orders.
 *
 * Safety rules (this hook runs inside payment settlement, after the customer
 * has already paid):
 * 1. It never throws. If anything fails, the line is saved without a snapshot
 *    and a warning is logged. A missing snapshot is better than a lost order.
 * 2. It reads products and variants WITHOUT `req`, so its reads run outside the
 *    settlement database transaction. A failed read cannot abort that transaction.
 * 3. It only writes the four snapshot fields on `orders.items`. It never touches
 *    `amount`, `transactions`, or any transaction document.
 * 4. It only runs on `create`, and never overwrites a `unitPrice` that is
 *    already set.
 *
 * Price rule matches the cart subtotal hook in the plugin: a line with a variant
 * uses the variant's price, a line without one uses the product's price. If that
 * price is missing we store no price rather than guess from the other document.
 */

const PRODUCTS = 'products'
const VARIANTS = 'variants'

type Id = number | string
type AnyRecord = Record<string, unknown>

const toID = (value: unknown): Id | undefined => {
    const id = value && typeof value === 'object' ? (value as {id?: unknown}).id : value

    if( typeof id === 'number' && Number.isFinite(id) ) return id
    if( typeof id === 'string' && id.length > 0 ) return id

    return undefined
}

const isCents = ( value: unknown ): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined

const snapshotItem = async ({
    item,
    payload,
    priceField,
}: {
    item: AnyRecord
    payload: Payload
    priceField: string | undefined
}): Promise<AnyRecord> => {
    //Already snapshotted (for example an order created with explicit data): keep it as-is.
    if(isCents(item.unitPrice)) return item

    const productID = toID(item.product)
    const variantID = toID(item.variant)

    const priceSelect = priceField ? { [priceField]: true } : {}

    const product = productID ? ((await payload.findByID({ 
        collection: PRODUCTS, 
        id: productID, 
        depth: 0, 
        select: { title: true, ...priceSelect } as never,})) as unknown as AnyRecord) : undefined

    const variant = variantID ? ((await payload.findByID({
        collection: VARIANTS, 
        id: variantID, 
        depth: 0, 
        select: { title: true, sku: true, ...priceSelect } as never,})) as unknown as AnyRecord) : undefined

    const priceSource = variantID ? variant : product
    const price = priceField ? priceSource?.[priceField] : undefined

    const snapshot: AnyRecord = {
        ...(isCents(price) ? { unitPrice: price } : {}),
        ...(text(product?.title) ? { productTitle: text(product?.title) } : {}),
        ...(text(variant?.title) ? { variantTitle: text(variant?.title) } : {}),
        ...(text(variant?.sku) ? { sku: text(variant?.sku) } : {}),
    }

    return { ...item, ...snapshot }
}

export const snapshotOrderItems: CollectionBeforeChangeHook = async ({ data, operation, req }) => {
    if( operation !== 'create' ) return data

    const items: unknown = data?.items

    if(!Array.isArray(items) || items.length === 0) return data

    const currency = typeof data.currency === 'string' && data.currency ? data.currency : undefined

    const priceField = currency ? `priceIn${currency.toUpperCase()}` : undefined

    const result: unknown[] = []

    for (const item of items) {
        try {
            result.push(
                item && typeof item === 'object' ? await snapshotItem({ item: item as AnyRecord, payload: req.payload, priceField }) : item,
            )
        } catch (error) {
            req.payload.logger.warn({err: error, msg: 'Order item snapshot failed, saving the item without snapshot',})
            result.push(item)
        }
    }

    return { ...data, items: result }
}