/**
 * Flat shipping with a free-shipping threshold. Pure, no database.
 * All amounts are whole cents.
 *
 * The free-shipping check uses the subtotal AFTER the discount, so a code cannot
 * be used to get free shipping on an order that is under the threshold once paid for.
 * It fails closed: invalid input returns a rejection, never a guessed price.
 */

import { isWholeCents, type ShippingSettings } from "./shippingSettings";

export type ShippingResult =
    | { ok: false; reason: 'invalid_amount' | 'invalid_settings' }
    | { ok: true; shippingTotal: number; free: boolean }

export const calculateShipping = (input: {
    /** Items total minus the discount, in cents. Never negative. */
    discountedSubtotal: number
    settings: ShippingSettings
}): ShippingResult => {
    const { discountedSubtotal, settings } = input

    if (
        typeof discountedSubtotal !== 'number' ||
        !Number.isSafeInteger(discountedSubtotal) ||
        discountedSubtotal < 0
    ) {
        return {ok: false, reason: 'invalid_amount' }
    }

    if (
        typeof settings !== 'object' ||
        settings === null ||
        !isWholeCents(settings.flatShippingCents, 0 ) ||
        !isWholeCents(settings.freeShippingThresholdCents, 1)
    ) {
        return {ok: false, reason: 'invalid_settings' }
    }

    //Exactly at the threshold counts as free.
    if (discountedSubtotal >= settings.freeShippingThresholdCents) {
        return {ok: true, shippingTotal: 0, free: true }
    }

    return { ok: true, shippingTotal: settings.flatShippingCents, free: settings.flatShippingCents === 0 }
}