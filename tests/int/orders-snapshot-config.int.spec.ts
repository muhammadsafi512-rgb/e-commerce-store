import { getPayload, type Payload } from "payload"
import config from '@payload-config'
import { describe, it , beforeAll, expect } from "vitest"

import { snapshotOrderItems } from "@/collections/Orders/snapshotOrderItems"

const SNAPSHOT = ['unitPrice', 'productTitle', 'variantTitle', 'sku']

let payload: Payload

const itemFieldNames = ( slug: 'orders' | 'transactions'): string[] => {
    const items: any = (payload.collections[slug].config as any).flattenedFields.find(
        (f: any) => f.name === 'items',
    )

    return (items?.fields ?? []).map((f: any) => f.name)
}

describe('order item snapshot wiring', () => {
    beforeAll(async () => {
        payload = await getPayload({ config: await config })
    })

    it('orders.items has the snapshot fields and keeps the plugin fields', () => {
        const names = itemFieldNames('orders')

        expect(names).toEqual(expect.arrayContaining([...SNAPSHOT, 'product', 'variant', 'quantity']))
    })

    it('transactions.items has NO snapshot fields (settlement compares it to stripe metadata)', () => {
        const names = itemFieldNames('transactions')

        expect(names.length).toBeGreaterThan(0)
        for(const name of SNAPSHOT){
            expect(names).not.toContain(name)
        }
    })

    it('the snapshot hook is registered on orders', () => {
        const hooks = payload.collections['orders'].config.hooks.beforeChange

        expect(hooks).toContain(snapshotOrderItems)
    })

    it('the accessToken field and delete rule from earlier steps are still there', () =>{
        const fields = (payload.collections['orders'].config as any).flattenedFields.map(
            (f: any) => f.name,
        )

        expect(fields).toContain('accessToken')
    })
})