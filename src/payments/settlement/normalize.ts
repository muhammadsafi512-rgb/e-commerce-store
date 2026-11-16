/**
 * Helpers copied in behaviour from the plugin's `validateSettlement.ts` (v3.92.1), which is not
 * exported. They must behave identically, because the webhook compares the Stripe metadata
 * snapshot with `transactions.items` exactly as the browser path does.
 */

type RecordValue = Record<string, unknown>

const isRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)

export const getRelationshitID = (value: unknown): string | undefined => {
    const id = isRecord(value) ? value.id : value

    if (typeof id === 'number' && Number.isFinite(id)) return String(id)
    if (typeof id === 'string' && id.trim()) return id

    return undefined
}

export const normalizeEmail = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined

    return value.trim().toLowerCase() || undefined
}

const normalizeValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry))

    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value).flatMap(([key, entry]) => {
                const normalized = normalizeValue(entry)

                return normalized === undefined ? [] : [[key, normalized]]
            }),
        )
    }

    if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return value
    if (value === undefined) return undefined

    throw new Error('Cart items contain unsupported data')
}

export const normalizeCartItems = (items: unknown): unknown[] => {
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error('Cart items are missing or invalid')
    }

    return items.map((item) => {
        if (!isRecord(item)) throw new Error('Cart items are missing or invalid')

        const productID = getRelationshitID(item.product)

        if(!productID || typeof item.quantity !== 'number' || !Number.isFinite(item.quantity)) {
            throw new Error('Cart items are missing or invalid')
        }

        return Object.fromEntries(
            Object.entries(item).flatMap(([key, value]) => {
                if (key === 'product') return [[key, productID]]

                if (key === 'variant') {
                    if (value === null || value === undefined) return []

                    const varianID = getRelationshitID(value)
                    if (!varianID) throw new Error('Cart item variant relationship is invalid')

                    return [[key, varianID]]
                }

                const normalized = normalizeValue(value)

                return normalized === undefined ? [] : [[key, normalized]]
            }),
        )
    })
}

const stableSerialize = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`

    if (isRecord(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
    }

    return JSON.stringify(value)
}

/**
 * True when both item lists describe the same cart lines. Throws if either is malformed.
 */

export const cartItemsMatch = (a: unknown, b:unknown): boolean => stableSerialize(normalizeCartItems(a)) === stableSerialize(normalizeCartItems(b))
