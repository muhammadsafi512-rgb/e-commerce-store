import { describe, it, expect , vi } from 'vitest'
import type { Field } from 'payload'

import { addSnapshotFields } from '@/collections/Orders/snapshotFields'
import { snapshotOrderItems } from '@/collections/Orders/snapshotOrderItems'

type Docs = Record<string, Record<string, unknown>>

/** Fake Payload request: `findByID` serves docs by `collection:id`; ids in `failing` throw. */

const makeReq = (docs: Docs, failing: string[] = []) => {
    const findByID = vi.fn(async ({ collection, id }: { collection: string, id: string | number }) => {
        const key = `${collection}:${id}`
        if(failing.includes(key)) throw new Error('boom')
        const doc = docs[key]
        if(!doc) throw new Error('Not found')
        return doc
})

const logger = { warn: vi.fn(), error: vi.fn() }
return { req: { payload: { findByID, logger } }, findByID, logger }
}

const run = (data: Record<string, unknown>, req: unknown, operation = 
    'create') => 
        snapshotOrderItems({ data, operation, req } as never) as Promise<Record<string, any>>

 const docs: Docs = {
    'products:1': { id: '1', title: 'Sage Bowl', priceInUSD: 2400 },
    'products:2': { id: '2', title: 'Stoneware Mug', priceInUSD: 1800 },
    'variants:10': { id: '10', title: 'Sage Bowl - Large', sku: 'BOWL-L', priceInUSD: 3200 },
 }

 describe('snapshotOrderItems', () => {
    it('snapshots a variant line: variant price titles and sku', async () => {
        const { req } = makeReq(docs)
        const out = await run({ currency: 'USD', amount: 6400, items: [{product: 1, variant: 10, quantity: 2 }] }, req,)

        expect(out.items[0]).toEqual({
            product: 1,
            variant: 10,
            quantity: 2,
            unitPrice: 3200,
            productTitle: 'Sage Bowl',
            variantTitle: 'Sage Bowl - Large',
            sku: 'BOWL-L',
        })
    })

    it('snapshots a product-only line with product price and no sku', async () => {
        const { req } = makeReq(docs)
        const out = await run({ currency: 'USD', items: [{ product: 2, quantity: 1 }] }, req)

        expect(out.items[0]).toEqual({
            product: 2,
            quantity: 1,
            unitPrice: 1800,
            productTitle: 'Stoneware Mug',
        })
    })

    it('accepts populated relationships and a lowercase currency', async () => {
        const { req } = makeReq(docs)
        const out = await run(
            { currency: 'usd', items: [{ product: { id: 1 }, variant: {id: 10}, quantity: 1}] }, 
            req,
        )

        expect(out.items[0].unitPrice).toBe(3200)
    })

    it('does not change amount, transactions or any other fields', async () => {
        const { req } = makeReq(docs)
        const data = {
            currency: 'USD',
            amount: 1800,
            transactions: [5],
            status: 'processing',
            items: [{ product: 2 , quantity: 1 }],
        }

        const out = await run (data, req)

        expect(out.amount).toBe(1800)
        expect(out.transactions).toEqual([5])
        expect(out.status).toBe('processing')
        expect(out.currency).toBe('USD')
    })
    
    it('does nothing on update', async () => {
        const { req, findByID } = makeReq(docs)
        const data = { currency: 'USD', items: [{ product: 1, quantity: 1}] }
        const out = await run(data, req, 'update')

        expect(out).toBe(data)
        expect(findByID).not.toHaveBeenCalled()
    })

    it('keeps an existing unitPrice and does not  look anything up', async () => {
        const { req, findByID } = makeReq(docs)
        const out = await run(
            { currency: 'USD', items: [{ product: 1 , quantity: 1, unitPrice: 999 }] },
            req,
        )

        expect(out.items[0].unitPrice).toBe(999)
        expect(findByID).not.toHaveBeenCalled()
    })
     it('stores no price when the price is missing, instead of guessing', async () => {
    const { req } = makeReq({
      ...docs,
      'variants:11': { id: 11, title: 'Sage Bowl — Small', sku: 'BOWL-S' }, // no price
    })
    const out = await run({ currency: 'USD', items: [{ product: 1, variant: 11, quantity: 1 }] }, req)
 
    expect(out.items[0].unitPrice).toBeUndefined()
    expect(out.items[0].sku).toBe('BOWL-S') // other snapshot fields still saved
  })
 
  it('stores titles but no price when the order has no currency', async () => {
    const { req } = makeReq(docs)
    const out = await run({ items: [{ product: 1, quantity: 1 }] }, req)
 
    expect(out.items[0].unitPrice).toBeUndefined()
    expect(out.items[0].productTitle).toBe('Sage Bowl')
  })
 
  it('never throws: a failing lookup leaves that line unchanged and others still snapshot', async () => {
    const { req, logger } = makeReq(docs, ['products:1'])
    const out = await run(
      {
        currency: 'USD',
        items: [
          { product: 1, quantity: 1 },
          { product: 2, quantity: 3 },
        ],
      },
      req,
    )
 
    expect(out.items[0]).toEqual({ product: 1, quantity: 1 })
    expect(out.items[1].unitPrice).toBe(1800)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
 
  it('a deleted product leaves the line unchanged without throwing', async () => {
    const { req } = makeReq({})
    const out = await run({ currency: 'USD', items: [{ product: 99, quantity: 1 }] }, req)
 
    expect(out.items[0]).toEqual({ product: 99, quantity: 1 })
  })
 
  it('reads outside the settlement transaction: never passes `req` to findByID', async () => {
    const { req, findByID } = makeReq(docs)
    await run({ currency: 'USD', items: [{ product: 1, variant: 10, quantity: 1 }] }, req)
 
    expect(findByID).toHaveBeenCalled()
    for (const [args] of findByID.mock.calls) {
      expect(args).not.toHaveProperty('req')
    }
  })
 
  it('returns data unchanged when there are no items', async () => {
    const { req } = makeReq(docs)
    const data = { currency: 'USD', items: [] as unknown[] }
 
    expect(await run(data, req)).toBe(data)
  })
})
 
describe('addSnapshotFields', () => {
  const tree: Field[] = [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Order details',
          fields: [
            {
              name: 'items',
              type: 'array',
              fields: [
                { name: 'product', type: 'text' },
                { name: 'quantity', type: 'number' },
              ],
            },
          ],
        },
        {
          label: 'Shipping',
          fields: [
            {
              name: 'shippingAddress',
              type: 'group',
              fields: [{ name: 'city', type: 'text' }],
            },
          ],
        },
      ],
    },
    { name: 'customer', type: 'text' },
    { name: 'notes', type: 'array', fields: [{ name: 'note', type: 'text' }] },
  ]
 
  const namesOf = (fields: Field[]) => fields.map((f) => ('name' in f ? f.name : f.type))
 
  it('appends the four snapshot fields to the items array inside tabs', () => {
    const out = addSnapshotFields(tree) as any[]
    const items = out[0].tabs[0].fields[0]
 
    expect(namesOf(items.fields)).toEqual([
      'product',
      'quantity',
      'unitPrice',
      'productTitle',
      'variantTitle',
      'sku',
    ])
  })
 
  it('leaves every other field untouched', () => {
    const out = addSnapshotFields(tree) as any[]
 
    expect(out[0].tabs[1]).toEqual((tree[0] as any).tabs[1])
    expect(out[1]).toEqual(tree[1])
    expect(namesOf(out[2].fields)).toEqual(['note']) // another array is not changed
  })
 
  it('does not mutate the input', () => {
    const before = JSON.stringify(tree)
    addSnapshotFields(tree)
 
    expect(JSON.stringify(tree)).toBe(before)
  })
})
