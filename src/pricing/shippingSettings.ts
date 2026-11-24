/**
 *  Shipping settings: types, defaults and a strict parser. Pure, no database.
 * All amounts are whole cents. 
 */

export type ShippingSettings = {
    /** Shipping charged when the order is under the free-shipping threshold. 0 is allowed. */
    flatShippingCents: number
    /** Orders whose discounted subtotal is at or above this get free shipping. At least 1. */
    freeShippingThresholdCents: number
}

/** Starting values for the admin form ($5.99 flat, free from $75.00). */

export const DEFAULT_FLAT_SHIPPING_CENTS = 599
export const DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS = 7500

/** Upper bound ($10,000) so a typo like an extra zero is rejected in the admin. */

export const MAX_SHIPPING_SETTINGS_CENTS = 1_000_000

export const isWholeCents = (value: unknown, min: number): value is number => 
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= MAX_SHIPPING_SETTINGS_CENTS

/** Returns valid settings , or null when anything is missing or malformed.
 *  It never fills in a guess: the caller decides what null means. 
 */

export const parseShippingSettings = (raw: unknown): null | ShippingSettings => {
    if (typeof raw !== 'object' || raw === null) return null

    const { flatShippingCents, freeShippingThresholdCents } = raw as Record<string, unknown>

    if (!isWholeCents(flatShippingCents, 0)) return null
    if (!isWholeCents(freeShippingThresholdCents, 1)) return null

    return { flatShippingCents, freeShippingThresholdCents }
}