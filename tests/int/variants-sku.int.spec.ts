import { getPayload, type Payload } from 'payload'
import config from '@/payload.config'
import { describe, it, expect, beforeAll } from 'vitest'

import { normalizeSku } from '@/utilities/normalizeSku'

describe('normalizeSku', () => {
    it('trims and uppercases', () => {
        expect(normalizeSku(' ab-12 ')).toBe('AB-12')
    })

    it('turns empty or whitespace-only strings into null', () => {
        expect(normalizeSku('')).toBeNull()
        expect(normalizeSku('   ')).toBeNull()
    })

    it('turns non-string values into null', () => {
        expect(normalizeSku(123)).toBeNull()
        expect(normalizeSku(undefined)).toBeNull()
        expect(normalizeSku(null)).toBeNull()
    })
})

describe('variants collection config', () => {
    let payload: Payload

    beforeAll(async () => {
        payload = await getPayload({ config: await config})
    })

    it('has an optional unique SKU field', async () => {
        const field: any = payload.collections['variants'].config.fields.find((f: any) => f.name === 'sku',)

        expect(field).toBeDefined()
        expect(field.type).toBe('text')
        expect(field.unique).toBe(true)
        expect(field.required).toBeFalsy()
        expect(field.index).toBe(true)
    })

    it('keeps the plugin default fields (inventory, product, options)', () => {
        const names = payload.collections['variants'].config.fields.map((f: any) => f.name)
        
        expect(names).toEqual(expect.arrayContaining(['inventory', 'product', 'options']))
    })
})