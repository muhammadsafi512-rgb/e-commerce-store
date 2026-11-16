import { describe, it, expect, vi } from 'vitest'

import { flagOversoldOrder } from '@/collections/Transactions/flagOversoldOrder'

type Docs = Record<string, { inventory?: unknown }>

/** Fake request. `stock` is what the database holds AFTER the plugin's decrement. */
const makeReq = (stock: Docs, options: { failRead?: boolean; failWrite?: boolean } = {}) => {
  const findByID = vi.fn(async ({ collection, id }: { collection: string; id: string | number }) => {
    if (options.failRead) throw new Error('read failed')
    const doc = stock[`${collection}:${id}`]
    if (!doc) throw Object.assign(new Error('Not Found'), { status: 404 })
    return doc
  })
  const updateOne = vi.fn(async () => {
    if (options.failWrite) throw new Error('write failed')
    return {}
  })
  const logger = { warn: vi.fn(), error: vi.fn() }

  return { req: { payload: { findByID, db: { updateOne }, logger } }, findByID, updateOne, logger }
}

const succeeded = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 5,
  status: 'succeeded',
  order: 77,
  items,
  ...extra,
})

const run = (args: Record<string, unknown>) => flagOversoldOrder(args as never) as Promise<unknown>

describe('flagOversoldOrder: flags', () => {
  it('flags the order when a variant went negative, and says which one', async () => {
    const { req, updateOne } = makeReq({ 'variants:10': { inventory: -1 } })
    const doc = succeeded([{ product: 1, variant: 10, quantity: 1 }])

    await run({ doc, operation: 'update', previousDoc: { status: 'processing' }, req })

    expect(updateOne).toHaveBeenCalledTimes(1)
    const call: any = (updateOne.mock.calls[0] as any[])[0]
    expect(call.collection).toBe('orders')
    expect(call.id).toBe(77)
    expect(call.data.needsAttention).toBe(true)
    expect(call.data.attentionReason).toContain('Variant 10')
    expect(call.data.attentionReason).toContain('-1')
  })

  it('flags a product-level item that went negative', async () => {
    const { req, updateOne } = makeReq({ 'products:2': { inventory: -2 } })

    await run({
      doc: succeeded([{ product: 2, quantity: 2 }]),
      operation: 'update',
      previousDoc: { status: 'processing' },
      req,
    })

    expect((updateOne.mock.calls[0] as any[])[0].data.attentionReason).toContain('Product 2')
  })

  it('lists only the oversold items when an order has several', async () => {
    const { req, updateOne } = makeReq({
      'variants:10': { inventory: 4 },
      'variants:11': { inventory: -3 },
      'products:2': { inventory: 0 },
    })

    await run({
      doc: succeeded([
        { product: 1, variant: 10, quantity: 1 },
        { product: 1, variant: 11, quantity: 3 },
        { product: 2, quantity: 1 },
      ]),
      operation: 'update',
      previousDoc: { status: 'processing' },
      req,
    })

    const reason: string = (updateOne.mock.calls[0] as any[])[0].data.attentionReason
    expect(reason).toContain('Variant 11')
    expect(reason).not.toContain('Variant 10')
    expect(reason).not.toContain('Product 2')
  })

  it('accepts populated relationships and an order given as an object', async () => {
    const { req, updateOne } = makeReq({ 'variants:10': { inventory: -1 } })

    await run({
      doc: succeeded([{ product: { id: 1 }, variant: { id: 10 }, quantity: 1 }], { order: { id: 77 } }),
      operation: 'update',
      previousDoc: { status: 'processing' },
      req,
    })

    expect((updateOne.mock.calls[0] as any[])[0].id).toBe(77)
  })
})

describe('flagOversoldOrder: does not flag', () => {
  it('leaves an order alone when stock is 0 or more (selling the last unit is fine)', async () => {
    const { req, updateOne } = makeReq({ 'variants:10': { inventory: 0 } })

    await run({
      doc: succeeded([{ product: 1, variant: 10, quantity: 1 }]),
      operation: 'update',
      previousDoc: { status: 'processing' },
      req,
    })

    expect(updateOne).not.toHaveBeenCalled()
  })

  it('ignores items that do not track stock', async () => {
    const { req, updateOne } = makeReq({ 'products:3': {} })

    await run({
      doc: succeeded([{ product: 3, quantity: 1 }]),
      operation: 'update',
      previousDoc: { status: 'processing' },
      req,
    })

    expect(updateOne).not.toHaveBeenCalled()
  })

  it('does nothing on create, or when the status is not succeeded', async () => {
    const { req, findByID, updateOne } = makeReq({ 'variants:10': { inventory: -1 } })
    const items = [{ product: 1, variant: 10, quantity: 1 }]

    await run({ doc: succeeded(items), operation: 'create', previousDoc: {}, req })
    await run({ doc: succeeded(items, { status: 'processing' }), operation: 'update', previousDoc: {}, req })
    await run({ doc: succeeded(items, { status: 'pending' }), operation: 'update', previousDoc: {}, req })

    expect(findByID).not.toHaveBeenCalled()
    expect(updateOne).not.toHaveBeenCalled()
  })

  it('runs once: an update when it was already succeeded is ignored', async () => {
    const { req, findByID, updateOne } = makeReq({ 'variants:10': { inventory: -1 } })

    await run({
      doc: succeeded([{ product: 1, variant: 10, quantity: 1 }]),
      operation: 'update',
      previousDoc: { status: 'succeeded' },
      req,
    })

    expect(findByID).not.toHaveBeenCalled()
    expect(updateOne).not.toHaveBeenCalled()
  })

  it('does nothing when there is no order or no items', async () => {
    const { req, findByID, updateOne } = makeReq({})

    await run({ doc: succeeded([{ product: 1, quantity: 1 }], { order: undefined }), operation: 'update', previousDoc: {}, req })
    await run({ doc: { id: 5, status: 'succeeded', order: 77 }, operation: 'update', previousDoc: {}, req })

    expect(findByID).not.toHaveBeenCalled()
    expect(updateOne).not.toHaveBeenCalled()
  })

  it('reads each product or variant once even when lines repeat', async () => {
    const { req, findByID } = makeReq({ 'variants:10': { inventory: 5 } })

    await run({
      doc: succeeded([
        { product: 1, variant: 10, quantity: 1 },
        { product: 1, variant: 10, quantity: 1 },
      ]),
      operation: 'update',
      previousDoc: { status: 'processing' },
      req,
    })

    expect(findByID).toHaveBeenCalledTimes(1)
  })
})

describe('flagOversoldOrder: safety (runs after the customer has paid)', () => {
  const items = [{ product: 1, variant: 10, quantity: 1 }]
  const previousDoc = { status: 'processing' }

  it('never throws when a read fails, writes nothing, and logs an error', async () => {
    const { req, updateOne, logger } = makeReq({}, { failRead: true })
    const doc = succeeded(items)

    await expect(run({ doc, operation: 'update', previousDoc, req })).resolves.toBe(doc)
    expect(updateOne).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('never throws when the write fails', async () => {
    const { req, logger } = makeReq({ 'variants:10': { inventory: -1 } }, { failWrite: true })
    const doc = succeeded(items)

    await expect(run({ doc, operation: 'update', previousDoc, req })).resolves.toBe(doc)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('returns the same doc untouched: the transaction and its items are never modified', async () => {
    const { req } = makeReq({ 'variants:10': { inventory: -1 } })
    const doc = succeeded(items)
    const before = JSON.stringify(doc)

    expect(await run({ doc, operation: 'update', previousDoc, req })).toBe(doc)
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('only writes needsAttention and attentionReason to the orders collection', async () => {
    const { req, updateOne } = makeReq({ 'variants:10': { inventory: -1 } })

    await run({ doc: succeeded(items), operation: 'update', previousDoc, req })

    const call: any = (updateOne.mock.calls[0] as any[])[0]
    expect(call.collection).toBe('orders')
    expect(Object.keys(call.data).sort()).toEqual(['attentionReason', 'needsAttention'])
  })

  it('passes req to its reads and its write, so it sees and joins the settlement transaction', async () => {
    const { req, findByID, updateOne } = makeReq({ 'variants:10': { inventory: -1 } })

    await run({ doc: succeeded(items), operation: 'update', previousDoc, req })

    expect((findByID.mock.calls[0] as any[])[0].req).toBe(req)
    expect((updateOne.mock.calls[0] as any[])[0].req).toBe(req)
  })
})