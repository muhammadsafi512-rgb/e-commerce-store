import type { Payload } from "payload";

/**
 * Server-side checkout validation. Runs BEFORE a Stripe PaymentIntent is created,
 * so throwing here is safe: nothing has been charged and no transaction exists yet.
 *
 * Why it exists: the plugin's own checks skip every cart line that has a variant
 * (the `if (item.variant)` block in `initiatePayment.ts` is nested inside
 * `if (item.product && !item.variant)` and never runs, decision #22). Our stock and
 * prices live on variants, so without this a sold-out variant can be paid for.
 *
 * It also recomputes the subtotal from current database prices, because the cart's
 * stored `subtotal` is only recalculated when the cart is saved.
 *
 * It never trusts anything populated on the cart: every product and variant is read
 * again from the database by ID.
 */

const PRODUCTS = 'products'
const VARIANTS = 'variants'

export class CheckoutValidationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CheckoutValidationError'
    }
}

type Id = number | string
type AnyRecord = Record<string, unknown>

export type ValidatedLine = {
    product: Id
    quantity: number
    unitPrice: number
    variant?: Id
}

export type ValidateCart = {
    lines: ValidatedLine[]
    /** Sum of unitPrice * quantity in minor units (cents), from current database prices. */
    subtotal: number
}

const toID = (value: unknown): Id | undefined => {
    const id = value && typeof value === 'object' ? (value as {id?: unknown}).id : value

    if (typeof id === 'number' && Number.isFinite(id)) return id
    if (typeof id === 'string' && id.length > 0 ) return id

    return undefined
}

const load = async (
    payload: Payload,
    collection: typeof PRODUCTS | typeof VARIANTS,
    id: Id,
    select: AnyRecord,
): Promise<AnyRecord> => {
    let doc: unknown

    try{
        doc = await payload.findByID({ collection, id , depth: 0 , select: select as never })
    } catch (error) {
        // Payload throws NotFound (status 404) for a missing document. Anything else is a
        // real failure (for example the database) and must not be reported as "not found".
        if ((error as { status?: number } | null)?.status === 404) {
            doc = null
        } else {
            throw error
        }
    }

    if (!doc || typeof doc !== 'object') {
        throw new CheckoutValidationError(`${collection} ${id} was not found`)
    }

    return doc as AnyRecord

}

export const validateCheckoutCart = async ({
    currency,
    items,
    payload,
}: {
    currency: string | undefined
    items: unknown
    payload: Payload
}): Promise<ValidateCart> => {
    if (!currency) throw new CheckoutValidationError('Currency is required')
    if (!Array.isArray(items) || items.length === 0 ) throw new CheckoutValidationError('Cart is empty')

    const priceField = `priceIn${currency.toUpperCase()}`

    const products = new Map<string, AnyRecord>()
    const variants = new Map<string, AnyRecord>()
// Stock needed per product or variant, summed across duplicate cart lines.

    const stock = new Map<string, {inventory: unknown; needed: number}>()

    const lines: ValidatedLine[] = []
    let subtotal = 0 

    for (const raw of items){
        const item = (raw && typeof raw === 'object' ? raw : {}) as AnyRecord

        const productID = toID(item.product)
        if (productID === undefined) throw new CheckoutValidationError('Cart line has no product')

        const variantID = toID(item.variant)

        const quantity = item.quantity === undefined || item.quantity === null ? 1 : item.quantity
        if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
            throw new CheckoutValidationError(`Invalid quantity for product ${productID}`)
        }

        const productKey = String(productID)
        let product = products.get(productKey)
        if(!product){
            product = await load(payload, PRODUCTS, productID, {
                _status: true,
                enableVariants: true,
                inventory: true,
                [priceField]: true,
            })
            products.set(productKey, product)
        }

        if(product._status === 'draft') {
            throw new CheckoutValidationError(`Product ${productID} is not published`)
        }

        let source: AnyRecord = product
        let stockKey = `product:${productKey}`

        if(variantID !== undefined) {
            const variantKey = String(variantID)
            let variant = variants.get(variantKey)
            if(!variant) {
                variant = await load(payload, VARIANTS, variantID, {
                    _status: true,
                    inventory: true,
                    product: true,
                    [priceField]: true,
                })
                variants.set(variantKey, variant)
            }
            

            if(variant._status === 'draft') {
                throw new CheckoutValidationError(`Variant ${variantID} is not published`)
            }

            if (String(toID(variant.product)) !== productKey) {
                throw new CheckoutValidationError(`Variant ${variantID} does not belong to product ${productID}`,)
            }

            source = variant
            stockKey = `variant:${variantKey}`
        } else if (product.enableVariants === true) {
            throw new CheckoutValidationError(`Product ${productID} requires a variant`)
        }

        const unitPrice = source[priceField]
        if (typeof unitPrice !== 'number' || !Number.isInteger(unitPrice) || unitPrice <= 0) {
            throw new CheckoutValidationError(
                `${variantID !== undefined ? `Variant ${variantID}` : `Product ${productID}`} has no valid price in ${currency}`,
            )
        }

        const entry = stock.get(stockKey) ?? {inventory: source.inventory, needed: 0}

        entry.needed += quantity
        stock.set(stockKey, entry)

        subtotal += unitPrice * quantity
        lines.push({
            product: productID,
            quantity,
            unitPrice,
            ...(variantID !== undefined ? { variant: variantID } : {}),
        })
    } 
    // Same rule as the plugin's default validation: stock is only enforced when the item
    // tracks inventory (a number). 0 means sold out. 
    for (const [key, {inventory, needed}] of stock) {
        if(typeof inventory === 'number' && inventory < needed) {
        throw new CheckoutValidationError(`${key} has ${inventory} in stock but ${needed} were requested`,)
    }
}
    if (!Number.isSafeInteger(subtotal) || subtotal <= 0) {
    throw new CheckoutValidationError('Cart total is not valid')
}
return { lines, subtotal }
}

