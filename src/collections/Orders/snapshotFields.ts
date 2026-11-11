import type { Field } from 'payload'

/**
 * Per-line snapshot fields added to `orders.items`.
 *
 * Values are written by the server when the order is created
 * (see `snapshotOrderItems`) and are read-only in the admin.
 * They are only ever added to ORDERS. Never add them to `transactions.items`:
 * settlement compares those items with the Stripe PaymentIntent metadata and
 * any difference makes every settlement fail.
 */

export const snapshotFields: Field[] = [
    {
        name: 'unitPrice',
        type: 'number',
        label: 'Unit price (cents)',
        min: 0,
        admin: {
            readOnly: true,
            description: 'The price of a single unit of this item, in cents. Written by the server when the order is created.',
        },
    },
    {
        name: 'productTitle',
        type: 'text',
        admin: { readOnly: true, description: 'The title of the product at the time of purchase. Written by the server when the order is created.' },
    },
    {
        name: 'variantTitle',
        type: 'text',
        admin: { readOnly: true, description: 'The title of the variant at the time of purchase. Written by the server when the order is created.' },
    },
    {
        name: 'sku',
        type: 'text',
        label: 'SKU',
        admin: { readOnly: true, description: 'The SKU of the variant at the time of purchase. If it had any.' },
    },
]

/**
 * Returns a copy of `fields` where the `items` array (it sits inside a `tabs`
 * field in the orders collection) has the snapshot fields appended.
 * Everything else is returned untouched.
 */

export const addSnapshotFields = (fields: Field[]): Field[] => fields.map((field) => {
    if (field.type === 'tabs') {
        return {
            ...field,
            tabs: field.tabs.map((tab) => ({ ...tab, fields: addSnapshotFields(tab.fields) })),
        }
    }
    if (field.type === 'array' && field.name === 'items') {
        return {
            ...field, fields: [...field.fields, ...snapshotFields]
        }
    }
 return field
})