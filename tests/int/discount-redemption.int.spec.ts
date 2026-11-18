import { describe, expect, it, vi } from 'vitest'

import { TransactionsCollection } from '../../src/collections/Transactions'
import { countDiscountRedemption } from '../../src/collections/Transactions/countDiscountRedemption'
import { flagOversoldOrder } from '../../src/collections/Transactions/flagOversoldOrder'

type Overrides = {
  find?: unknown
  logger?: { error: unknown; warn: unknown }
  updateOne?: unknown
}

const makeReq = (o: Overrides = {}) => {
  const logger = (o.logger as never) ?? { error: vi.fn(), warn: vi.fn() }
  const find = o.find ?? vi.fn().mockResolvedValue({ docs: [{ code: 'SUMMER10', id: 3, redemptions: 4 }] })
  const updateOne = o.updateOne ?? vi.fn().mockResolvedValue({ id: 3 })
  const req = { payload: { db: { updateOne }, find, logger } }
  return { find, logger: logger as { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }, req, updateOne }
}

const run = async (
  args: { doc?: Record<string, unknown>; operation?: string; previousDoc?: Record<string, unknown> },
  o: Overrides = {},
) => {
  const m = makeReq(o)
  const doc = args.doc ?? { discountCode: 'SUMMER10', id: 7, status: 'succeeded' }
  const result = await countDiscountRedemption({
    doc,
    operation: args.operation ?? 'update',
    previousDoc: args.previousDoc ?? { status: 'processing' },
    req: m.req,
  } as never)
  return { ...m, doc, result }
}

describe('countDiscountRedemption', () => {
  it('adds one redemption when the transaction becomes succeeded', async () => {
    const { result, doc, updateOne } = await run({})
    expect(updateOne).toHaveBeenCalledTimes(1)
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'discount-codes', data: { redemptions: { $inc: 1 } }, id: 3 }),
    )
    expect(result).toBe(doc)
  })

  it('looks the code up by the code saved on the transaction', async () => {
    const { find } = await run({})
    expect((find as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      collection: 'discount-codes',
      limit: 1,
      where: { code: { equals: 'SUMMER10' } },
    })
  })

  it('passes req to the read and the write, so they join the settlement transaction', async () => {
    const { find, req, updateOne } = await run({})
    expect((find as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].req).toBe(req)
    expect((updateOne as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].req).toBe(req)
  })

  it('writes only `redemptions`', async () => {
    const { updateOne } = await run({})
    const data = (updateOne as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].data
    expect(Object.keys(data)).toEqual(['redemptions'])
  })

  it.each([
    ['a create', { operation: 'create' }],
    ['a transaction that is not succeeded', { doc: { discountCode: 'SUMMER10', status: 'processing' } }],
    ['a transaction that was already succeeded', { previousDoc: { status: 'succeeded' } }],
    ['no code', { doc: { discountCode: null, status: 'succeeded' } }],
    ['a blank code', { doc: { discountCode: '  ', status: 'succeeded' } }],
    ['a missing code', { doc: { status: 'succeeded' } }],
    ['a non-text code', { doc: { discountCode: 5, status: 'succeeded' } }],
  ])('counts nothing for %s', async (_n, args) => {
    const { find, updateOne } = await run(args)
    expect(find).not.toHaveBeenCalled()
    expect(updateOne).not.toHaveBeenCalled()
  })

  it('counts exactly once across the settlement updates (processing, then succeeded, then an admin edit)', async () => {
    const m = makeReq()
    const call = (doc: Record<string, unknown>, previousDoc: Record<string, unknown>) =>
      countDiscountRedemption({ doc, operation: 'update', previousDoc, req: m.req } as never)
    await call({ discountCode: 'SUMMER10', status: 'processing' }, { status: 'pending' })
    await call({ discountCode: 'SUMMER10', status: 'succeeded' }, { status: 'processing' })
    await call({ discountCode: 'SUMMER10', status: 'succeeded' }, { status: 'succeeded' })
    expect(m.updateOne).toHaveBeenCalledTimes(1)
  })

  it('warns and carries on when the code no longer exists', async () => {
    const { doc, logger, result, updateOne } = await run({}, { find: vi.fn().mockResolvedValue({ docs: [] }) })
    expect(updateOne).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(result).toBe(doc)
  })

  it('never throws when the lookup fails: logs and returns the transaction', async () => {
    const { doc, logger, result, updateOne } = await run({}, { find: vi.fn().mockRejectedValue(new Error('db down')) })
    expect(result).toBe(doc)
    expect(updateOne).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('never throws when the write fails', async () => {
    const { doc, logger, result } = await run({}, { updateOne: vi.fn().mockRejectedValue(new Error('write failed')) })
    expect(result).toBe(doc)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('never throws even when logging fails', async () => {
    const logger = { error: () => { throw new Error('log down') }, warn: vi.fn() }
    const { doc, result } = await run({}, { find: vi.fn().mockRejectedValue(new Error('x')), logger })
    expect(result).toBe(doc)
  })

  it('returns the transaction unchanged', async () => {
    const before = { discountCode: 'SUMMER10', id: 7, status: 'succeeded' }
    const { result } = await run({ doc: { ...before } })
    expect(result).toEqual(before)
  })
})

describe('TransactionsCollection wiring', () => {
  const build = (hooks?: Record<string, unknown[]>) =>
    (TransactionsCollection as unknown as (a: unknown) => { hooks: Record<string, unknown[]> })({
      defaultCollection: { fields: [], hooks, slug: 'transactions' },
    })

  it('registers both afterChange hooks, oversold first', () => {
    const { hooks } = build()
    expect(hooks.afterChange).toEqual([flagOversoldOrder, countDiscountRedemption])
  })

  it('keeps hooks the plugin already has', () => {
    const existing = () => undefined
    const { hooks } = build({ afterChange: [existing], beforeValidate: [existing] })
    expect(hooks.afterChange).toEqual([existing, flagOversoldOrder, countDiscountRedemption])
    expect(hooks.beforeValidate).toEqual([existing])
  })
})