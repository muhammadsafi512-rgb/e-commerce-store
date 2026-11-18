import { describe, expect, it, vi } from 'vitest'

import { copyPricingToOrder } from '../../src/collections/Orders/copyPricingToOrder'
import { orderPricingFields } from '../../src/collections/Orders/pricingFields'
import { readTransactionBreakdown } from '../../src/pricing/pricingBreakdown'

const goodTx = (overrides: Record<string, unknown> = {}) => ({
  amount: 4500,
  discountCode: 'SUMMER10',
  discountTotal: 500,
  id: 7,
  shippingTotal: 0,
  subtotal: 5000,
  ...overrides,
})

describe('readTransactionBreakdown', () => {
  it('reads a stored breakdown, with the amount as the total', () => {
    expect(readTransactionBreakdown(goodTx())).toEqual({
      discountCode: 'SUMMER10',
      discountTotal: 500,
      shippingTotal: 0,
      subtotal: 5000,
      total: 4500,
    })
  })

  it('reads a no-code breakdown (null or missing code)', () => {
    const base = { amount: 5000, discountTotal: 0, shippingTotal: 0, subtotal: 5000 }
    expect(readTransactionBreakdown({ ...base, discountCode: null })?.discountCode).toBeNull()
    expect(readTransactionBreakdown(base)?.discountCode).toBeNull()
  })

  it('returns null for a transaction without a breakdown (before 8b)', () => {
    expect(readTransactionBreakdown({ amount: 5000, id: 1 })).toBeNull()
    expect(readTransactionBreakdown({ amount: 5000, subtotal: null, discountTotal: null, shippingTotal: null })).toBeNull()
  })

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['amount differs from subtotal - discount + shipping', goodTx({ amount: 4400 })],
    ['discount larger than subtotal', goodTx({ discountTotal: 6000, amount: 1 })],
    ['discount without a code', goodTx({ discountCode: null })],
    ['empty code', goodTx({ discountCode: '' })],
    ['fractional cents', goodTx({ subtotal: 5000.5, amount: 4500.5 })],
    ['negative shipping', goodTx({ shippingTotal: -1, amount: 4499 })],
    ['missing shipping', goodTx({ shippingTotal: undefined })],
    ['amount zero', goodTx({ amount: 0, discountTotal: 5000 })],
  ])('rejects: %s', (_name, tx) => {
    expect(readTransactionBreakdown(tx)).toBeNull()
  })
})

describe('orderPricingFields', () => {
  it('has the four fields, read-only, and nothing else', () => {
    expect(orderPricingFields.map((f) => ('name' in f ? f.name : null))).toEqual([
      'subtotal',
      'discountCode',
      'discountTotal',
      'shippingTotal',
    ])
    for (const field of orderPricingFields) {
      expect((field as { admin?: { readOnly?: boolean } }).admin?.readOnly).toBe(true)
    }
  })
})

const makeReq = (findByID: unknown) => {
  const logger = { error: vi.fn(), warn: vi.fn() }
  return { logger, req: { payload: { findByID, logger } } }
}

const run = async (
  args: { data?: Record<string, unknown>; operation?: string },
  findByID: unknown = vi.fn().mockResolvedValue(goodTx()),
) => {
  const { logger, req } = makeReq(findByID)
  const data = args.data ?? { amount: 4500, transactions: [7] }
  const result = await copyPricingToOrder({ data, operation: args.operation ?? 'create', req } as never)
  return { findByID, logger, result: result as Record<string, unknown> }
}

describe('copyPricingToOrder', () => {
  it('copies the breakdown from the transaction onto a new order', async () => {
    const { result } = await run({})
    expect(result).toMatchObject({
      amount: 4500,
      discountCode: 'SUMMER10',
      discountTotal: 500,
      shippingTotal: 0,
      subtotal: 5000,
      transactions: [7],
    })
  })

  it('reads the transaction by id without req, with depth 0', async () => {
    const { findByID } = await run({})
    const call = (findByID as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(call).toMatchObject({ collection: 'transactions', depth: 0, id: 7 })
    expect('req' in call).toBe(false)
  })

  it('accepts a populated transaction relationship', async () => {
    const { result } = await run({ data: { amount: 4500, transactions: [{ id: 7 }] } })
    expect(result.subtotal).toBe(5000)
  })

  it('copies a no-code breakdown (discount 0, code null)', async () => {
    const tx = goodTx({ amount: 5000, discountCode: null, discountTotal: 0 })
    const { result } = await run({ data: { amount: 5000, transactions: [7] } }, vi.fn().mockResolvedValue(tx))
    expect(result).toMatchObject({ discountCode: null, discountTotal: 0, subtotal: 5000 })
  })

  it('does nothing on update', async () => {
    const { findByID, result } = await run({ operation: 'update' })
    expect(result.subtotal).toBeUndefined()
    expect(findByID).not.toHaveBeenCalled()
  })

  it('leaves a breakdown that is already on the data alone', async () => {
    const { findByID, result } = await run({ data: { amount: 4500, subtotal: 1, transactions: [7] } })
    expect(result.subtotal).toBe(1)
    expect(findByID).not.toHaveBeenCalled()
  })

  it.each([
    ['no transactions', { amount: 4500 }],
    ['empty transactions', { amount: 4500, transactions: [] }],
    ['unusable transaction id', { amount: 4500, transactions: [{}] }],
  ])('saves the order untouched with %s', async (_n, data) => {
    const { findByID, result } = await run({ data })
    expect(result).toEqual(data)
    expect(findByID).not.toHaveBeenCalled()
  })

  it('saves the order untouched when the transaction has no breakdown', async () => {
    const data = { amount: 5000, transactions: [7] }
    const { logger, result } = await run({ data }, vi.fn().mockResolvedValue({ amount: 5000, id: 7 }))
    expect(result).toEqual(data)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('does not copy a breakdown whose total differs from the order amount, and warns', async () => {
    const data = { amount: 4000, transactions: [7] }
    const { logger, result } = await run({ data })
    expect(result).toEqual(data)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('does not copy a breakdown that does not add up', async () => {
    const data = { amount: 4400, transactions: [7] }
    const { result } = await run({ data }, vi.fn().mockResolvedValue(goodTx({ amount: 4400 })))
    expect(result).toEqual(data)
  })

  it('never throws when the read fails: the order is saved untouched and the error logged', async () => {
    const data = { amount: 4500, transactions: [7] }
    const { logger, result } = await run({ data }, vi.fn().mockRejectedValue(new Error('db down')))
    expect(result).toEqual(data)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('never throws even when logging fails', async () => {
    const data = { amount: 4500, transactions: [7] }
    const findByID = vi.fn().mockRejectedValue(new Error('db down'))
    const req = { payload: { findByID, logger: { error: () => { throw new Error('log down') }, warn: vi.fn() } } }
    await expect(copyPricingToOrder({ data, operation: 'create', req } as never)).resolves.toEqual(data)
  })

  it('never touches amount, items or status', async () => {
    const data = { amount: 4500, items: [{ product: 1, quantity: 1 }], status: 'processing', transactions: [7] }
    const { result } = await run({ data })
    expect(result.amount).toBe(4500)
    expect(result.items).toEqual(data.items)
    expect(result.status).toBe('processing')
    expect(Object.keys(result).sort()).toEqual(
      ['amount', 'discountCode', 'discountTotal', 'items', 'shippingTotal', 'status', 'subtotal', 'transactions'].sort(),
    )
  })
})