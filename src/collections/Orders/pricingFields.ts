import type { Field } from "payload";

const display = ( description: string ) => ({
    description,
    position: 'sidebar' as const,
    readOnly: true,
})
/**
 * Price breakdown of the order, in cents. Copied from the transaction when the order
 * is created (see `copyPricingToOrder`), never typed in. Read-only in the admin.
 *
 * Always: subtotal - discountTotal + shippingTotal = amount.
 * Orders created before step 8b/8c have none of these.
 */
export const orderPricingFields: Field[] = [
    {
        name: 'subtotal',
        type: 'number',
        min: 0,
        admin: display('Items total in cents, before discount and shipping.'),
    },
    {
        name: 'discountCode',
        type: 'text',
        admin: display('Discount code used on this, if any.'),
    },
    {
        name: 'discountTotal',
        type: 'number',
        min: 0,
        admin: display('Cents taken off the items total.')
    },
    {
        name: 'shippingTotal',
        type: 'number',
        min: 0,
        admin: display('Shipping in cents.')
    }
]