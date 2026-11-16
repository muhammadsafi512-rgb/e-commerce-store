import { getPayload, type Payload } from "payload";
import config from '@/payload.config'
import { describe, it, beforeAll, expect } from "vitest";

import { flagOversoldOrder } from "@/collections/Transactions/flagOversoldOrder";

let payload: Payload

const fieldsOf = (slug: 'orders' | 'transactions') => (payload.collections[slug].config as any).flattenedFields as any[]

describe('oversold flag wiring', () => {
    beforeAll(async () => {
        payload = await getPayload({ config: await config })
    })

    it('orders have needsAttention (checkbox, default false) and attentionReason', () => {
        const flag = fieldsOf('orders').find((f) => f.name === 'needsAttention')
        const reason = fieldsOf('orders').find((f) => f.name === 'attentionReason')

        expect(flag?.type).toBe('checkbox')
        expect(flag?.defaultValue).toBe(false)
        expect(reason).toBeDefined()
    })

    it('both fields are readable and writable by admins only', async() => {
        const admin = {id: 1, roles: ['admin'] }
        const customer = {id: 2, roles: ['customer'] }

        for(const name of ['needsAttention', 'attentionReason']) {
            const field = fieldsOf('orders').find((f) => f.name === name)

            for (const op of ['read', 'create', 'update']) {
                expect(await field.access[op]({ req: { user: admin} })).toBe(true)
                expect(await field.access[op]({ req: { user: customer} })).toBe(false)
                expect(await field.access[op]({ req: { user: null} })).toBe(false)
            }
        }
    })
    it('the flag hook is registered on transactions', () => {
        expect(payload.collections['transactions'].config.hooks.afterChange).toContain(flagOversoldOrder)
    })

    it('transactions.items is unchanged: no snapshot or attention fields(settelment compares it to Stripe)', () => {
        const items = fieldsOf('transactions').find((f) => f.name === 'items')
        const names: string[] = (items?.fields ?? []).map((f: any) => f.name)

        expect(names.length).toBeGreaterThan(0)
        for(const name of ['unitPrice', 'productTitle', 'variantTitle', 'sku', 'needsAttention']) {
            expect(names).not.toContain(name)
        }
    })

    it('earlier steps are still wired: accessToken, snapshot fields, snapshot hook', () => {
        const names = fieldsOf('orders').map((f) => f.name)

        expect(names).toEqual(expect.arrayContaining(['accessToken','needsAttention']))

        expect(payload.collections['orders'].config.hooks.beforeChange.length).toBeGreaterThan(0)
    })
})