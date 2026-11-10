import type { CollectionOverride } from '@payloadcms/plugin-ecommerce/types';
import { normalizeSku } from '@/utilities/normalizeSku';

/**
 * Extends the plugin's default 'variants' collection with an optional unique SKU.
 * All default field, hooks, access and versions are kept. 
 */

export const VariantsCollection: CollectionOverride = ({
    defaultCollection }) => ({
        ...defaultCollection,
        fields: [
            ...defaultCollection.fields,
            {
                name: 'sku',
                type: 'text',
                unique: true,
                label: 'SKU',
                index: true,
                admin: {
                    position: 'sidebar',
                    description: 'Optional. Unique per variant. Saved in uppercase.',
                },
                hooks: {
                    beforeValidate: [({ value }) => normalizeSku(value)],   
                },
            },
        ],
    })