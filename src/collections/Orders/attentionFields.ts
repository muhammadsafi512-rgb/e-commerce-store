import type { Field } from "payload";

import { adminOnlyFieldAccess } from "@/access/adminOnlyFieldAccess";

/**
 * Internal flag for orders an admin must look at, for example when two customers paid for the last unit(descision #24).
 * Admin-only to read and write through the API, so customers never see it on their orders.
 * The server sets it through the database adapter, which bypasses field access, so the rule only restricts people.
 */

export const attentionFields: Field[] = [
    {
        name: 'needsAttention',
        type:'checkbox',
        label:'Needs Attention',
        defaultValue: false,
        index: true,
        access: {
            create: adminOnlyFieldAccess,
            read: adminOnlyFieldAccess,
            update: adminOnlyFieldAccess,
        },
        admin: {
            position: 'sidebar',
            description: 'Set by the system when something needs a person, for example an oversold item. Untick once handled.',
        },
    },
    {
        name: 'attentionReason',
        type: 'textarea',
        label: 'Why it needs attention',
        access: {
            create: adminOnlyFieldAccess,
            read: adminOnlyFieldAccess,
            update: adminOnlyFieldAccess,
        },
        admin: {
            position: 'sidebar',
            condition: (data) => Boolean(data?.needsAttention || data?.attentionReason),
        },
    },
]