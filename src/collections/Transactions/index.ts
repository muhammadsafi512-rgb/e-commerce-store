import type { CollectionOverride } from "@payloadcms/plugin-ecommerce/types";

import { applyPricingBreakdown } from "./applyPricingBreakdown";
import { countDiscountRedemption } from "./countDiscountRedemption";
import { flagOversoldOrder } from "./flagOversoldOrder";
import { pricingBreakdownFields } from "./pricingBreakdownFields";

/**
 * Adds our hooks and four read-only price fields to the plugin's 'transactions' collection.
 *
 * 'transactions.items' must stay exactly as the plugin writes it, because settlement
 * compares it with the Stripe PaymentIntent metadata. The new fields are appended after
 * the plugin's own fields and are never part of 'items'.
 *
 * - beforeChange `applyPricingBreakdown` (create only): saves subtotal, discount and
 *   shipping with the transaction (decision #39).
 * - afterChange `flagOversoldOrder`: flags oversold orders after settlement (decision #35).
 * - afterChange `countDiscountRedemption`: counts a discount code use when the payment is
 *   settled (decision #40).
 */

export const TransactionsCollection: CollectionOverride = ({
    defaultCollection }) => ({
        ...defaultCollection,
        fields: [...defaultCollection.fields, ...pricingBreakdownFields],
        hooks: {
            ...defaultCollection.hooks,
            afterChange: [
                ...(defaultCollection.hooks?.afterChange ?? []),
                flagOversoldOrder,
                countDiscountRedemption,
            ],
            beforeChange: [...(defaultCollection.hooks?.beforeChange ?? []), applyPricingBreakdown],
        },
    })