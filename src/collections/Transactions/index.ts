import type { CollectionOverride } from "@payloadcms/plugin-ecommerce/types";

import { flagOversoldOrder } from "./flagOversoldOrder";

/**
 * Adds our hooks to the plugin's 'transactions' collection. Fields are NOT CHANGED:
 * 'transactions.items' must stay exactly as the plugin writes it, 
 * because settlement compares it with the Stripe PaymentIntent metadata.
 */

export const TransactionsCollection: CollectionOverride = ({
    defaultCollection }) => ({
        ...defaultCollection,
        hooks: {
            afterChange: [...(defaultCollection.hooks?.afterChange ?? []), flagOversoldOrder],
        },
    })