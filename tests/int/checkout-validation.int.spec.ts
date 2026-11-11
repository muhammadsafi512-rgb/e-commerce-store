import { describe, it, expect, vi } from 'vitest'

import { CheckoutValidationError, validateCheckoutCart } from '@/payments/validateCheckoutCart'
import { withCheckoutValidation } from '@/payments/withCheckoutValidation'

type Docs = Record<string, Record<string, unknown>>

/** Fake Payload: `findByID` serves docs by `collection:id`; a missing doc throws a 404 like Payload. */
const makePayload = (docs: Docs) => {
  const findByID = vi.fn(async ({ collection, id }: { collection: string; id: string | number }) => {
    const doc = docs[`${collection}:${id}`]
    if (!doc) throw Object.assign(new Error('Not Found'), { status: 404 })
    return doc
  })
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }

  return { payload: { findByID, logger } as never, findByID, logger }
}

const baseDocs = (): Docs => ({
  'products:1': { id: 1, _status: 'published', enableVariants: true },
  'variants:10': { id: 10, _status: 'published', product: 1, inventory: 5, priceInUSD: 3200 },
  'variants:11': { id: 11, _status: 'published', product: 1, inventory: 0, priceInUSD: 2800 },
  'products:2': { id: 2, _status: 'published', enableVariants: false, inventory: 3, priceInUSD: 1800 },
  'products:3': { id: 3, _status: 'published', enableVariants: false, priceInUSD: 900 }, // untracked stock
})

const validate = (items: unknown, docs: Docs = baseDocs(), currency = 'USD') => {
  const { payload } = makePayload(docs)
  return validateCheckoutCart({ currency, items, payload })
}

describe('validateCheckoutCart: the happy path', () => {
  it('computes the subtotal from database prices (variant and product lines)', async () => {
    const result = await validate([
      { product: 1, variant: 10, quantity: 2 },
      { product: 2, quantity: 1 },
    ])

    expect(result.subtotal).toBe(3200 * 2 + 1800)
    expect(result.lines).toEqual([
      { product: 1, variant: 10, quantity: 2, unitPrice: 3200 },
      { product: 2, quantity: 1, unitPrice: 1800 },
    ])
  })

  it('accepts populated relationships and a lowercase currency', async () => {
    const result = await validate(
      [{ product: { id: 1 }, variant: { id: 10 }, quantity: 1 }],
      baseDocs(),
      'usd',
    )

    expect(result.subtotal).toBe(3200)
  })

  it('treats a missing quantity as 1', async () => {
    expect((await validate([{ product: 2 }])).subtotal).toBe(1800)
  })

  it('does not enforce stock for items that do not track inventory', async () => {
    expect((await validate([{ product: 3, quantity: 500 }])).subtotal).toBe(900 * 500)
  })

  it('allows buying exactly the remaining stock', async () => {
    expect((await validate([{ product: 1, variant: 10, quantity: 5 }])).subtotal).toBe(16000)
  })

  it('reads every product and variant once even when lines repeat', async () => {
    const { payload, findByID } = makePayload(baseDocs())
    await validateCheckoutCart({
      currency: 'USD',
      items: [
        { product: 1, variant: 10, quantity: 1 },
        { product: 1, variant: 10, quantity: 1 },
      ],
      payload,
    })

    expect(findByID).toHaveBeenCalledTimes(2) // 1 product + 1 variant
  })
})

describe('validateCheckoutCart: stock (the plugin bug this fixes)', () => {
  it('blocks a sold-out variant (inventory 0)', async () => {
    await expect(validate([{ product: 1, variant: 11, quantity: 1 }])).rejects.toThrow(
      CheckoutValidationError,
    )
  })

  it('blocks a variant when more than the stock is requested', async () => {
    await expect(validate([{ product: 1, variant: 10, quantity: 6 }])).rejects.toThrow(/in stock/)
  })

  it('sums duplicate lines of the same variant before comparing with stock', async () => {
    await expect(
      validate([
        { product: 1, variant: 10, quantity: 3 },
        { product: 1, variant: 10, quantity: 3 },
      ]),
    ).rejects.toThrow(/6 were requested/)
  })

  it('blocks a product-level item that is out of stock', async () => {
    const docs = baseDocs()
    docs['products:2'].inventory = 0

    await expect(validate([{ product: 2, quantity: 1 }], docs)).rejects.toThrow(/in stock/)
  })

  it('blocks stock that has gone negative after an earlier oversell', async () => {
    const docs = baseDocs()
    docs['variants:10'].inventory = -1

    await expect(validate([{ product: 1, variant: 10, quantity: 1 }], docs)).rejects.toThrow()
  })
})

describe('validateCheckoutCart: integrity rules', () => {
  it('blocks an unpublished product', async () => {
    const docs = baseDocs()
    docs['products:2']._status = 'draft'

    await expect(validate([{ product: 2, quantity: 1 }], docs)).rejects.toThrow(/not published/)
  })

  it('blocks an unpublished variant', async () => {
    const docs = baseDocs()
    docs['variants:10']._status = 'draft'

    await expect(validate([{ product: 1, variant: 10, quantity: 1 }], docs)).rejects.toThrow(
      /not published/,
    )
  })

  it('blocks a variant that belongs to a different product', async () => {
    await expect(validate([{ product: 2, variant: 10, quantity: 1 }])).rejects.toThrow(
      /does not belong/,
    )
  })

  it('blocks a variant-enabled product bought without a variant', async () => {
    await expect(validate([{ product: 1, quantity: 1 }])).rejects.toThrow(/requires a variant/)
  })

  it('blocks a missing or zero price', async () => {
    const docs = baseDocs()
    docs['variants:10'].priceInUSD = 0
    delete docs['products:2'].priceInUSD

    await expect(validate([{ product: 1, variant: 10, quantity: 1 }], docs)).rejects.toThrow(
      /valid price/,
    )
    await expect(validate([{ product: 2, quantity: 1 }], docs)).rejects.toThrow(/valid price/)
  })

  it('does not fall back to the product price when the variant has none', async () => {
    const docs = baseDocs()
    delete docs['variants:10'].priceInUSD
    docs['products:1'].priceInUSD = 100

    await expect(validate([{ product: 1, variant: 10, quantity: 1 }], docs)).rejects.toThrow(
      /valid price/,
    )
  })

  it('blocks a price in a currency the product does not have', async () => {
    await expect(validate([{ product: 2, quantity: 1 }], baseDocs(), 'EUR')).rejects.toThrow(
      /valid price/,
    )
  })

  it('blocks a deleted product or variant', async () => {
    await expect(validate([{ product: 99, quantity: 1 }])).rejects.toThrow(/not found/)
    await expect(validate([{ product: 1, variant: 99, quantity: 1 }])).rejects.toThrow(/not found/)
  })

  it('blocks invalid quantities', async () => {
    for (const quantity of [0, -1, 1.5, '2', Number.NaN]) {
      await expect(validate([{ product: 2, quantity }])).rejects.toThrow(/quantity/)
    }
  })

  it('blocks an empty cart, a missing currency and a line without a product', async () => {
    await expect(validate([])).rejects.toThrow(/empty/)
    await expect(validate(undefined)).rejects.toThrow(/empty/)
    await expect(validate([{ quantity: 1 }])).rejects.toThrow(/no product/)
    await expect(validateCheckoutCart({ currency: '', items: [{ product: 2 }], payload: makePayload(baseDocs()).payload })).rejects.toThrow(/Currency/)
  })

  it('does not hide real failures as "not found"', async () => {
    const payload = {
      findByID: vi.fn().mockRejectedValue(new Error('connection terminated')),
      logger: { warn: vi.fn() },
    } as never

    const error = await validateCheckoutCart({
      currency: 'USD',
      items: [{ product: 2, quantity: 1 }],
      payload,
    }).catch((e) => e)

    expect(error).not.toBeInstanceOf(CheckoutValidationError)
    expect(error.message).toBe('connection terminated')
  })
})

describe('withCheckoutValidation', () => {
  const cart = {
    id: 7,
    currency: 'USD',
    subtotal: 1, // stale on purpose
    items: [{ id: 'a', product: 1, variant: 10, quantity: 2 }],
  }

  const makeAdapter = () => {
    const initiatePayment = vi.fn(async () => ({ message: 'ok', clientSecret: 'cs_1' }))
    const adapter = {
      name: 'stripe',
      label: 'Stripe',
      confirmOrder: vi.fn(),
      endpoints: [{ path: '/x' }],
      group: { name: 'stripe' },
      initiatePayment,
    } as never as Parameters<typeof withCheckoutValidation>[0]

    return { adapter, initiatePayment }
  }

  const call = (wrapped: ReturnType<typeof withCheckoutValidation>, docs: Docs, cartData = cart) => {
    const { payload, logger } = makePayload(docs)
    const args = {
      data: { cart: cartData, currency: 'USD', customerEmail: 'a@b.c' },
      req: { payload },
      transactionsSlug: 'transactions',
    } as never

    return { result: wrapped.initiatePayment(args), logger }
  }

  it('passes a corrected subtotal to the real adapter and returns its result', async () => {
    const { adapter, initiatePayment } = makeAdapter()
    const { result, logger } = call(withCheckoutValidation(adapter), baseDocs())

    expect(await result).toEqual({ message: 'ok', clientSecret: 'cs_1' })

    const passed: any = (initiatePayment.mock.calls[0] as any[])[0]
    expect(passed.data.cart.subtotal).toBe(6400)
    expect(logger.warn).toHaveBeenCalledTimes(1) // logged the stale subtotal
  })

  it('leaves the cart items, the other data and the other args untouched', async () => {
    const { adapter, initiatePayment } = makeAdapter()
    await call(withCheckoutValidation(adapter), baseDocs()).result

    const passed: any = (initiatePayment.mock.calls[0] as any[])[0]
    expect(passed.data.cart.items).toBe(cart.items) // same array: settlement snapshot stays identical
    expect(passed.data.cart.id).toBe(7)
    expect(passed.data.customerEmail).toBe('a@b.c')
    expect(passed.transactionsSlug).toBe('transactions')
    expect(cart.subtotal).toBe(1) // input not mutated
  })

  it('does not log a warning when the stored subtotal is already right', async () => {
    const { adapter } = makeAdapter()
    const { result, logger } = call(withCheckoutValidation(adapter), baseDocs(), { ...cart, subtotal: 6400 })
    await result

    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('blocks a sold-out variant and never calls the real adapter (no PaymentIntent created)', async () => {
    const { adapter, initiatePayment } = makeAdapter()
    const { result, logger } = call(withCheckoutValidation(adapter), baseDocs(), {
      ...cart,
      items: [{ id: 'a', product: 1, variant: 11, quantity: 1 }],
    })

    await expect(result).rejects.toThrow(CheckoutValidationError)
    expect(initiatePayment).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('keeps every other part of the adapter, so settlement is untouched', () => {
    const { adapter } = makeAdapter()
    const wrapped = withCheckoutValidation(adapter)

    expect(wrapped.name).toBe('stripe')
    expect(wrapped.label).toBe('Stripe')
    expect(wrapped.confirmOrder).toBe(adapter.confirmOrder)
    expect(wrapped.endpoints).toBe(adapter.endpoints)
    expect(wrapped.group).toBe(adapter.group)
    expect(wrapped.initiatePayment).not.toBe(adapter.initiatePayment)
  })
})