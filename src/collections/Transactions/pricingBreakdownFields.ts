import type { Field } from "payload";

const display = (description: string) => ({
    description,
    position: 'sidebar' as const,
    readOnly: true,
})

/**
 * Price breakdown of the checkout attempt, in cents. Written once, by the server,
 * when the transaction is created (see `applyPricingBreakdown`). Read-only in the
 * admin. They sit next to `amount`; they never touch `items`.
 *
 * Always: subtotal - discountTotal + shippingTotal = amount.
 */

export const pricingBreakdownFields: Field[] = [
    {
        name: 'subtotal',
        type: 'number',
        min: 0,
        admin: display('Items total in cents, before discount and shipping.'),
    },
    {
        name: 'discountCode',
        type: 'text',
        admin: display('Discount code applied at checkout, if any.'),
    },
    {
        name: 'discountTotal',
        type: 'number',
        min: 0,
        admin: display('Cents taken off the items total.'),
    },
    {
        name: 'shippingTotal',
        type: 'number',
        min: 0,
        admin: display('Shipping in cents.'),
    },
]