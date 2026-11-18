import type { CollectionConfig, Field } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { TransactionsCollection } from '../../src/collections/Transactions'
import { applyPricingBreakdown } from '../../src/collections/Transactions/applyPricingBreakdown'
import { countDiscountRedemption } from '../../src/collections/Transactions/countDiscountRedemption'
import { flagOversoldOrder } from '../../src/collections/Transactions/flagOversoldOrder'
import { pricingBreakdownFields } from '../../src/collections/Transactions/pricingBreakdownFields'
import {
  PRICING_CONTEXT_KEY,
  buildPricingBreakdown,
  readPricingBreakdown,
} from '../../src/pricing/pricingBreakdown'

const breakdown = (overrides: Record<string, unknown> = {}) => ({
  discountCode: 'SUMMER10',
  discountTotal: 500,
  shippingTotal: 0,
  subtotal: 5000,
  total: 4500,
  ...overrides,
})

const contextWith = (value: unknown) => ({ [PRICING_CONTEXT_KEY]: value })

const fakeReq = () => {
  const logger = { error: vi.fn(), warn: vi.fn() }
  return { logger, req: { payload: { logger } } }
}

const runHook = async (args: { context?: unknown; data: Record<string, unknown>; operation: string; req?: unknown }) => {
  const { req } = fakeReq()
  return applyPricingBreakdown({ req, ...args } as never)
}

describe('buildPricingBreakdown', () => {
  it('adds the total as subtotal - discount + shipping', () => {
    expect(
      buildPricingBreakdown({ discountCode: 'X', discountTotal: 500, shippingTotal: 599, subtotal: 5000 }),
    ).toEqual({ discountCode: 'X', discountTotal: 500, shippingTotal: 599, subtotal: 5000, total: 5099 })
  })

  it('works with no discount', () => {
    expect(
      buildPricingBreakdown({ discountCode: null, discountTotal: 0, shippingTotal: 0, subtotal: 5000 }).total,
    ).toBe(5000)
  })
})

describe('readPricingBreakdown', () => {
  it('reads a valid breakdown', () => {
    expect(readPricingBreakdown(contextWith(breakdown()))).toEqual(breakdown())
  })

  it('reads a breakdown with no discount and with shipping', () => {
    const value = breakdown({ discountCode: null, discountTotal: 0, shippingTotal: 599, total: 5599 })
    expect(readPricingBreakdown(contextWith(value))).toEqual(value)
  })

  it('accepts a code that took nothing off (tiny percent)', () => {
    const value = breakdown({ discountTotal: 0, total: 5000 })
    expect(readPricingBreakdown(contextWith(value))).toEqual(value)
  })

  it('returns null when there is nothing usable', () => {
    for (const bad of [undefined, null, 'x', 5, [], {}, contextWith(undefined), contextWith(null), contextWith('x')]) {
      expect(readPricingBreakdown(bad)).toBeNull()
    }
  })

  it('returns null for amounts that are not whole non-negative numbers', () => {
    for (const bad of [
      { subtotal: 0, total: 0, discountTotal: 0 },
      { subtotal: -5 },
      { subtotal: 50.5 },
      { discountTotal: -1 },
      { discountTotal: 1.5 },
      { shippingTotal: -1 },
      { shippingTotal: 1.5 },
      { total: 0 },
      { total: Number.NaN },
      { subtotal: '5000' },
    ]) {
      expect(readPricingBreakdown(contextWith(breakdown(bad)))).toBeNull()
    }
  })

  it('returns null when the numbers do not add up', () => {
    expect(readPricingBreakdown(contextWith(breakdown({ total: 4600 })))).toBeNull()
    expect(readPricingBreakdown(contextWith(breakdown({ shippingTotal: 100 })))).toBeNull()
  })

  it('returns null when the discount is bigger than the subtotal', () => {
    expect(readPricingBreakdown(contextWith(breakdown({ discountTotal: 6000, total: 100, shippingTotal: 1100 })))).toBeNull()
  })

  it('returns null for an amount taken off without a code, or a bad code', () => {
    expect(readPricingBreakdown(contextWith(breakdown({ discountCode: null })))).toBeNull()
    expect(readPricingBreakdown(contextWith(breakdown({ discountCode: '' })))).toBeNull()
    expect(readPricingBreakdown(contextWith(breakdown({ discountCode: 5 })))).toBeNull()
  })
})

describe('applyPricingBreakdown (transactions beforeChange hook)', () => {
  const items = [{ product: 1, quantity: 2, variant: 7 }]
  const data = () => ({ amount: 4500, currency: 'USD', items, status: 'pending' })

  it('saves the four fields on create', async () => {
    const result = await runHook({ context: contextWith(breakdown()), data: data(), operation: 'create' })
    expect(result).toMatchObject({
      discountCode: 'SUMMER10',
      discountTotal: 500,
      shippingTotal: 0,
      subtotal: 5000,
    })
  })

  it('saves a null code and zero discount when no code was used', async () => {
    const value = breakdown({ discountCode: null, discountTotal: 0, total: 5000 })
    const result = await runHook({
      context: contextWith(value),
      data: { ...data(), amount: 5000 },
      operation: 'create',
    })
    expect(result).toMatchObject({ discountCode: null, discountTotal: 0, subtotal: 5000 })
  })

  it('never touches items, amount or the other fields', async () => {
    const input = data()
    const result = (await runHook({ context: contextWith(breakdown()), data: input, operation: 'create' })) as Record<string, unknown>
    expect(result.items).toBe(items)
    expect(result.amount).toBe(4500)
    expect(result.currency).toBe('USD')
    expect(result.status).toBe('pending')
    expect(Object.keys(result).sort()).toEqual(
      ['amount', 'currency', 'discountCode', 'discountTotal', 'items', 'shippingTotal', 'status', 'subtotal'],
    )
  })

  it('does not mutate the data it was given', async () => {
    const input = data()
    await runHook({ context: contextWith(breakdown()), data: input, operation: 'create' })
    expect(input).toEqual(data())
  })

  it('does nothing on update, so settlement is untouched', async () => {
    const input = data()
    const result = await runHook({ context: contextWith(breakdown()), data: input, operation: 'update' })
    expect(result).toBe(input)
  })

  it('does nothing when the request carries no breakdown', async () => {
    const { logger, req } = fakeReq()
    const input = data()
    for (const context of [undefined, {}, { other: 1 }]) {
      const result = await applyPricingBreakdown({ context, data: input, operation: 'create', req } as never)
      expect(result).toBe(input)
    }
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('does not save a breakdown that does not add up, and warns', async () => {
    const { logger, req } = fakeReq()
    const input = data()
    const result = await applyPricingBreakdown({
      context: contextWith(breakdown({ total: 4600 })),
      data: input,
      operation: 'create',
      req,
    } as never)
    expect(result).toBe(input)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('does not save a breakdown whose total differs from the transaction amount, and warns', async () => {
    const { logger, req } = fakeReq()
    const input = { ...data(), amount: 5000 }
    const result = await applyPricingBreakdown({
      context: contextWith(breakdown()),
      data: input,
      operation: 'create',
      req,
    } as never)
    expect(result).toBe(input)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('never throws, even when the context or the logger is broken', async () => {
    const input = data()
    const exploding = new Proxy({}, {
      get() {
        throw new Error('boom')
      },
    })
    expect(await applyPricingBreakdown({ context: exploding, data: input, operation: 'create', req: fakeReq().req } as never)).toBe(input)

    const brokenLogger = { payload: { logger: { error: () => { throw new Error('log boom') }, warn: () => { throw new Error('log boom') } } } }
    expect(
      await applyPricingBreakdown({ context: contextWith(breakdown({ total: 1 })), data: input, operation: 'create', req: brokenLogger } as never),
    ).toBe(input)
    expect(await applyPricingBreakdown({ context: exploding, data: input, operation: 'create', req: {} } as never)).toBe(input)
  })
})

describe('pricing breakdown fields', () => {
  it('has the four planned fields, read-only in the admin, and nothing named items', () => {
    const names = pricingBreakdownFields.map((f) => ('name' in f ? f.name : undefined))
    expect(names).toEqual(['subtotal', 'discountCode', 'discountTotal', 'shippingTotal'])
    for (const f of pricingBreakdownFields) {
      expect((f as { admin: { readOnly: boolean } }).admin.readOnly).toBe(true)
    }
  })

  it('amounts cannot be negative', () => {
    for (const f of pricingBreakdownFields) {
      if (f.type === 'number') expect(f.min).toBe(0)
    }
  })
})

describe('TransactionsCollection override', () => {
  const itemsTabs: Field = {
    type: 'tabs',
    tabs: [{ fields: [{ name: 'items', type: 'array', fields: [{ name: 'product', type: 'text' }] }], label: 'Details' }],
  }
  const status: Field = { name: 'status', type: 'text' }
  const existingBefore = vi.fn()
  const existingAfter = vi.fn()
  const defaultCollection = {
    slug: 'transactions',
    access: { read: () => true },
    admin: { group: 'Ecommerce' },
    fields: [itemsTabs, status],
    hooks: { afterChange: [existingAfter], beforeChange: [existingBefore] },
  } as unknown as CollectionConfig

  const build = async () => (await TransactionsCollection({ defaultCollection })) as CollectionConfig

  it('keeps every default field untouched and appends ours after them', async () => {
    const result = await build()
    expect(result.fields.slice(0, 2)).toEqual([itemsTabs, status])
    expect(result.fields[0]).toBe(itemsTabs)
    expect(result.fields.slice(2)).toEqual(pricingBreakdownFields)
  })

  it('adds no field to the items array', async () => {
    const result = await build()
    const tabs = result.fields[0] as { tabs: Array<{ fields: Array<{ fields?: unknown[] }> }> }
    expect(tabs.tabs[0]!.fields[0]!.fields).toEqual([{ name: 'product', type: 'text' }])
  })

  it('registers both hooks and keeps the default ones', async () => {
    const result = await build()
    expect(result.hooks?.beforeChange).toEqual([existingBefore, applyPricingBreakdown])
    expect(result.hooks?.afterChange).toEqual([existingAfter, flagOversoldOrder, countDiscountRedemption])
  })

  it('keeps the rest of the default collection', async () => {
    const result = await build()
    expect(result.slug).toBe('transactions')
    expect(result.access).toBe(defaultCollection.access)
    expect(result.admin).toBe(defaultCollection.admin)
  })

  it('keeps default hooks of other kinds too', async () => {
    const beforeValidate = vi.fn()
    const result = (await TransactionsCollection({
      defaultCollection: {
        ...defaultCollection,
        hooks: { ...defaultCollection.hooks, beforeValidate: [beforeValidate] },
      } as CollectionConfig,
    })) as CollectionConfig
    expect(result.hooks?.beforeValidate).toEqual([beforeValidate])
  })

  it('works when the default collection has no hooks', async () => {
    const result = (await TransactionsCollection({
      defaultCollection: { ...defaultCollection, hooks: undefined } as CollectionConfig,
    })) as CollectionConfig
    expect(result.hooks?.beforeChange).toEqual([applyPricingBreakdown])
    expect(result.hooks?.afterChange).toEqual([flagOversoldOrder, countDiscountRedemption])
  })
})