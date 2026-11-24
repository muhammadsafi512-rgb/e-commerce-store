import { afterEach, describe, expect, it, vi } from 'vitest'

// Lets one test force a shipping failure that real, validated input cannot produce.
const shippingFailure = vi.hoisted(() => ({ forced: false }))

vi.mock('../../src/pricing/calculateShipping', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pricing/calculateShipping')>()
  return {
    ...actual,
    calculateShipping: (...args: Parameters<typeof actual.calculateShipping>) =>
      shippingFailure.forced
        ? ({ ok: false, reason: 'invalid_amount' } as const)
        : actual.calculateShipping(...args),
  }
})

import {
  DISCOUNT_REJECTED_CODE,
  DISCOUNT_REJECTED_MESSAGE,
  withCheckoutValidation,
} from '../../src/payments/withCheckoutValidation'
import { CheckoutValidationError } from '../../src/payments/validateCheckoutCart'
import { ShippingSettingsError } from '../../src/pricing/getShippingSettings'
import { PRICING_CONTEXT_KEY, readPricingBreakdown } from '../../src/pricing/pricingBreakdown'

afterEach(() => {
  shippingFailure.forced = false
})

/** Shipping off: every order ships for 0 cents. Keeps the discount tests about discounts alone. */
const NO_SHIPPING = { flatShippingCents: 0, freeShippingThresholdCents: 1 }

/** The agreed defaults: $5.99 flat, free from $75.00 (on the subtotal after the discount). */
const FLAT = { flatShippingCents: 599, freeShippingThresholdCents: 7500 }

const code = (overrides: Record<string, unknown> = {}) => ({
  active: true,
  code: 'SUMMER10',
  expiresAt: null,
  maxRedemptions: null,
  redemptions: 0,
  type: 'percent',
  value: 10,
  ...overrides,
})

const publishedProduct = (overrides: Record<string, unknown> = {}) => ({
  _status: 'published',
  enableVariants: false,
  inventory: 10,
  priceInUSD: 5000,
  ...overrides,
})

const setup = ({
  discountDocs = [] as unknown[],
  findError,
  products = { '1': publishedProduct() } as Record<string, unknown>,
  settings = NO_SHIPPING as unknown,
  settingsError,
}: {
  discountDocs?: unknown[]
  findError?: Error
  products?: Record<string, unknown>
  settings?: unknown
  settingsError?: Error
} = {}) => {
  const logger = { error: vi.fn(), warn: vi.fn() }
  const payload = {
    find: vi.fn(async (_args: unknown) => {
      if (findError) throw findError
      return { docs: discountDocs }
    }),
    findByID: vi.fn(async ({ collection, id }: { collection: string; id: number | string }) => {
      const store = collection === 'products' ? products : {}
      const doc = store[String(id)]
      if (!doc) throw Object.assign(new Error('Not found'), { status: 404 })
      return doc
    }),
    findGlobal: vi.fn(async (_args: unknown) => {
      if (settingsError) throw settingsError
      return settings
    }),
    logger,
  }
  const response = { clientSecret: 'cs_1', message: 'Payment initiated successfully', paymentIntentID: 'pi_1' }
  const adapter = {
    confirmOrder: vi.fn(),
    endpoints: [{ handler: vi.fn(), method: 'post', path: '/stripe/webhooks' }],
    group: { name: 'stripe', type: 'group' },
    initiatePayment: vi.fn(async (_args: unknown) => response),
    label: 'Stripe',
    name: 'stripe',
  }
  return { adapter, logger, payload, response }
}

const run = async (
  ctx: ReturnType<typeof setup>,
  {
    body,
    cartSubtotal = 5000,
    req = { context: {}, data: body, payload: ctx.payload },
  }: {
    body?: Record<string, unknown> | undefined
    cartSubtotal?: number
    req?: Record<string, unknown>
  } = {},
) => {
  const items = [{ product: 1, quantity: 1 }]
  const wrapped = withCheckoutValidation(ctx.adapter as never)
  const result = await wrapped.initiatePayment({
    customersSlug: 'users',
    data: {
      billingAddress: {},
      cart: { currency: 'USD', id: 42, items, subtotal: cartSubtotal },
      currency: 'USD',
      customerEmail: 'a@b.co',
    },
    req,
    transactionsSlug: 'transactions',
  } as never)
  const passed = ctx.adapter.initiatePayment.mock.calls[0]?.[0] as
    | { data: { cart: { items: unknown; subtotal: number } } }
    | undefined
  return { items, passed, req, result }
}

/** The `pricing` field of the response. Typed here because the plugin's return type has no such field. */
const pricingOf = (result: unknown) =>
  (result as { pricing: Record<string, unknown> & { shippingTotal: number } }).pricing

describe('withCheckoutValidation: discount codes', () => {
  it('charges the discounted total and saves the breakdown on the request', async () => {
    const ctx = setup({ discountDocs: [code()] })
    const { items, passed, req, result } = await run(ctx, { body: { discountCode: 'summer10' } })

    expect(passed?.data.cart.subtotal).toBe(4500)
    expect(passed?.data.cart.items).toBe(items)
    expect((req.context as Record<string, unknown>)[PRICING_CONTEXT_KEY]).toEqual({
      discountCode: 'SUMMER10',
      discountTotal: 500,
      shippingTotal: 0,
      subtotal: 5000,
      total: 4500,
    })
    expect(result).toEqual({
      ...ctx.response,
      pricing: { discountCode: 'SUMMER10', discountTotal: 500, shippingTotal: 0, subtotal: 5000, total: 4500 },
    })
  })

  it('looks the code up by its normalised form', async () => {
    const ctx = setup({ discountDocs: [code()] })
    await run(ctx, { body: { discountCode: '  sUmMeR10 ' } })
    expect(ctx.payload.find.mock.calls[0]?.[0]).toMatchObject({ where: { code: { equals: 'SUMMER10' } } })
  })

  it('applies a fixed code', async () => {
    const ctx = setup({ discountDocs: [code({ type: 'fixed', value: 700 })] })
    const { passed } = await run(ctx, { body: { discountCode: 'SUMMER10' } })
    expect(passed?.data.cart.subtotal).toBe(4300)
  })

  it('uses the database subtotal, not the cart subtotal, before applying the code', async () => {
    const ctx = setup({ discountDocs: [code()] })
    const { passed } = await run(ctx, { body: { discountCode: 'SUMMER10' }, cartSubtotal: 1 })
    expect(passed?.data.cart.subtotal).toBe(4500)
  })

  it('ignores amounts sent by the browser: only the code text is used', async () => {
    const ctx = setup({ discountDocs: [code()] })
    const { passed, req } = await run(ctx, {
      body: { discountCode: 'SUMMER10', discountTotal: 4999, shippingTotal: 0, subtotal: 1, total: 1 },
    })
    expect(passed?.data.cart.subtotal).toBe(4500)
    expect((req.context as Record<string, { discountTotal: number }>)[PRICING_CONTEXT_KEY]?.discountTotal).toBe(500)
  })

  it('accepts exactly the Stripe minimum', async () => {
    const ctx = setup({ discountDocs: [code({ type: 'fixed', value: 4950 })] })
    const { passed } = await run(ctx, { body: { discountCode: 'BIG' } })
    expect(passed?.data.cart.subtotal).toBe(50)
  })

  describe('rejections: nothing is charged or created', () => {
    const cases: Array<[string, unknown[], string]> = [
      ['unknown code', [], 'not_found'],
      ['inactive', [code({ active: false })], 'inactive'],
      ['expired', [code({ expiresAt: '2000-01-01T00:00:00.000Z' })], 'expired'],
      ['used up', [code({ maxRedemptions: 3, redemptions: 3 })], 'exhausted'],
      ['total below the Stripe minimum', [code({ type: 'fixed', value: 4951 })], 'below_minimum'],
      ['items taken to zero', [code({ type: 'fixed', value: 5000 })], 'items_total_zero'],
      ['more than the whole cart', [code({ type: 'fixed', value: 9000 })], 'items_total_zero'],
      ['100 percent', [code({ value: 100 })], 'invalid_definition'],
      ['malformed record', [{ code: 'X', type: 'weird', value: 'ten' }], 'invalid_definition'],
    ]

    it.each(cases)('%s', async (_name, docs, reason) => {
      const ctx = setup({ discountDocs: docs })
      const { passed, req, result } = await run(ctx, { body: { discountCode: 'SUMMER10' } })

      expect(ctx.adapter.initiatePayment).not.toHaveBeenCalled()
      expect(passed).toBeUndefined()
      expect((req.context as Record<string, unknown>)[PRICING_CONTEXT_KEY]).toBeUndefined()
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ cartID: 42, msg: `Discount code rejected: ${reason}` }),
      )
      expect(result).toEqual({
        error: JSON.stringify({ cause: { code: DISCOUNT_REJECTED_CODE }, message: DISCOUNT_REJECTED_MESSAGE }),
        message: DISCOUNT_REJECTED_MESSAGE,
      })
    })

    it('gives the same answer for every reason, so codes cannot be probed', async () => {
      const answers = new Set<string>()
      for (const [, docs] of cases) {
        const ctx = setup({ discountDocs: docs })
        const { result } = await run(ctx, { body: { discountCode: 'SUMMER10' } })
        answers.add(JSON.stringify(result))
      }
      expect(answers.size).toBe(1)
    })

    it('the error string is JSON the checkout page can read', async () => {
      const ctx = setup({ discountDocs: [] })
      const { result } = await run(ctx, { body: { discountCode: 'NOPE' } })
      const parsed = JSON.parse((result as unknown as { error: string }).error)
      expect(parsed.cause.code).toBe('DiscountCodeRejected')
    })

    it('does not log more than 64 characters of the typed code', async () => {
      const ctx = setup({ discountDocs: [] })
      await run(ctx, { body: { discountCode: 'A'.repeat(500) } })
      const logged = ctx.logger.warn.mock.calls[0]?.[0] as { code: string }
      expect(logged.code.length).toBe(64)
    })
  })

  it.each([[10], [{ $ne: null }], [['SUMMER10']], [true]])(
    'refuses a code that is not text (%j) instead of ignoring it',
    async (value) => {
      const ctx = setup({ discountDocs: [code()] })
      const { passed, req, result } = await run(ctx, { body: { discountCode: value } })

      expect(ctx.adapter.initiatePayment).not.toHaveBeenCalled()
      expect(passed).toBeUndefined()
      expect(ctx.payload.find).not.toHaveBeenCalled()
      expect((req.context as Record<string, unknown>)[PRICING_CONTEXT_KEY]).toBeUndefined()
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'Discount code rejected: invalid_input' }),
      )
      expect(JSON.parse((result as unknown as { error: string }).error).cause.code).toBe(DISCOUNT_REJECTED_CODE)
    },
  )

  it('rethrows a database failure while looking the code up (not "invalid code")', async () => {
    const ctx = setup({ findError: new Error('Connection terminated unexpectedly') })
    await expect(run(ctx, { body: { discountCode: 'SUMMER10' } })).rejects.toThrow('Connection terminated unexpectedly')
    expect(ctx.adapter.initiatePayment).not.toHaveBeenCalled()
  })

  it('checks the cart first: a blocked cart throws and the code is never looked up', async () => {
    const ctx = setup({ discountDocs: [code()], products: { '1': publishedProduct({ inventory: 0 }) } })
    await expect(run(ctx, { body: { discountCode: 'SUMMER10' } })).rejects.toBeInstanceOf(CheckoutValidationError)
    expect(ctx.payload.find).not.toHaveBeenCalled()
    expect(ctx.adapter.initiatePayment).not.toHaveBeenCalled()
  })

  it('passes the adapter error through when the adapter fails', async () => {
    const ctx = setup({ discountDocs: [code()] })
    ctx.adapter.initiatePayment.mockRejectedValueOnce(new Error('Stripe is down'))
    await expect(run(ctx, { body: { discountCode: 'SUMMER10' } })).rejects.toThrow('Stripe is down')
  })
})

describe('withCheckoutValidation: no discount code', () => {
  it.each([
    ['no body at all', undefined],
    ['no code field', {}],
    ['empty code', { discountCode: '' }],
    ['blank code', { discountCode: '   ' }],
    ['null code', { discountCode: null }],
  ])('%s: charges the database total, looks no code up, returns the adapter response plus pricing', async (_name, body) => {
    const ctx = setup({ discountDocs: [code()] })
    const { passed, req, result } = await run(ctx, { body: body as Record<string, unknown> | undefined })

    const expected = {
      discountCode: null,
      discountTotal: 0,
      shippingTotal: 0,
      subtotal: 5000,
      total: 5000,
    }

    expect(ctx.payload.find).not.toHaveBeenCalled()
    expect(passed?.data.cart.subtotal).toBe(5000)
    expect(result).toEqual({ ...ctx.response, pricing: expected })
    expect((req.context as Record<string, unknown>)[PRICING_CONTEXT_KEY]).toEqual(expected)
    // The adapter's own response object is not changed.
    expect(ctx.response).not.toHaveProperty('pricing')
  })

  it('still corrects a stale cart subtotal and logs it', async () => {
    const ctx = setup()
    const { passed } = await run(ctx, { cartSubtotal: 3000 })
    expect(passed?.data.cart.subtotal).toBe(5000)
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ cartSubtotal: 3000, subtotal: 5000 }))
  })

  it('keeps the rest of the adapter as it was', () => {
    const ctx = setup()
    const wrapped = withCheckoutValidation(ctx.adapter as never)
    expect(wrapped.name).toBe('stripe')
    expect(wrapped.label).toBe('Stripe')
    expect(wrapped.confirmOrder).toBe(ctx.adapter.confirmOrder)
    expect(wrapped.endpoints).toBe(ctx.adapter.endpoints)
    expect(wrapped.group).toBe(ctx.adapter.group)
  })

  it('keeps context set by other code on the same request', async () => {
    const ctx = setup()
    const req = { context: { other: 'kept' }, data: {}, payload: ctx.payload }
    await withCheckoutValidation(ctx.adapter as never).initiatePayment({
      data: { billingAddress: {}, cart: { currency: 'USD', id: 1, items: [{ product: 1, quantity: 1 }], subtotal: 5000 }, currency: 'USD', customerEmail: 'a@b.co' },
      req,
    } as never)
    expect((req.context as Record<string, unknown>).other).toBe('kept')
  })

  it('works when the request has no context object yet', async () => {
    const ctx = setup()
    const req: Record<string, unknown> = { data: {}, payload: ctx.payload }
    await withCheckoutValidation(ctx.adapter as never).initiatePayment({
      data: { billingAddress: {}, cart: { currency: 'USD', id: 1, items: [{ product: 1, quantity: 1 }], subtotal: 5000 }, currency: 'USD', customerEmail: 'a@b.co' },
      req,
    } as never)
    expect((req.context as Record<string, unknown>)[PRICING_CONTEXT_KEY]).toBeDefined()
  })
})

describe('withCheckoutValidation: shipping', () => {
  const priced = (cents: number) => ({ '1': publishedProduct({ priceInUSD: cents }) })

  it('adds the flat rate under the threshold and charges the total', async () => {
    const ctx = setup({ settings: FLAT })
    const { passed, req, result } = await run(ctx)

    const expected = { discountCode: null, discountTotal: 0, shippingTotal: 599, subtotal: 5000, total: 5599 }

    expect(passed?.data.cart.subtotal).toBe(5599)
    expect((req.context as Record<string, unknown>)[PRICING_CONTEXT_KEY]).toEqual(expected)
    expect(result).toEqual({ ...ctx.response, pricing: expected })
  })

  it('is free at the threshold and charged one cent below it', async () => {
    const at = setup({ products: priced(7500), settings: FLAT })
    const atRun = await run(at, { cartSubtotal: 7500 })
    expect(atRun.passed?.data.cart.subtotal).toBe(7500)
    expect(pricingOf(atRun.result).shippingTotal).toBe(0)

    const below = setup({ products: priced(7499), settings: FLAT })
    const belowRun = await run(below, { cartSubtotal: 7499 })
    expect(belowRun.passed?.data.cart.subtotal).toBe(7499 + 599)
    expect(pricingOf(belowRun.result).shippingTotal).toBe(599)
  })

  it('uses the admin-saved numbers, not built-in ones', async () => {
    const ctx = setup({ settings: { flatShippingCents: 1234, freeShippingThresholdCents: 99_999 } })
    const { passed } = await run(ctx)
    expect(passed?.data.cart.subtotal).toBe(5000 + 1234)
  })

  it('decides free shipping on the subtotal AFTER the discount', async () => {
    // 8000 is over the threshold, but 10% off leaves 7200, which is not: shipping is charged.
    const under = setup({ discountDocs: [code()], products: priced(8000), settings: FLAT })
    const underRun = await run(under, { body: { discountCode: 'SUMMER10' }, cartSubtotal: 8000 })
    expect(underRun.passed?.data.cart.subtotal).toBe(7200 + 599)
    expect(pricingOf(underRun.result)).toEqual({
      discountCode: 'SUMMER10',
      discountTotal: 800,
      shippingTotal: 599,
      subtotal: 8000,
      total: 7799,
    })

    // 8000 - 500 = 7500, exactly the threshold: free.
    const exact = setup({ discountDocs: [code({ type: 'fixed', value: 500 })], products: priced(8000), settings: FLAT })
    const exactRun = await run(exact, { body: { discountCode: 'SUMMER10' }, cartSubtotal: 8000 })
    expect(exactRun.passed?.data.cart.subtotal).toBe(7500)
    expect(pricingOf(exactRun.result).shippingTotal).toBe(0)
  })

  it('rejects a code that takes the items to zero, even though shipping would cover the minimum', async () => {
    const ctx = setup({ discountDocs: [code({ type: 'fixed', value: 5000 })], settings: FLAT })
    const { passed, req, result } = await run(ctx, { body: { discountCode: 'SUMMER10' } })

    expect(ctx.adapter.initiatePayment).not.toHaveBeenCalled()
    expect(passed).toBeUndefined()
    expect((req.context as Record<string, unknown>)[PRICING_CONTEXT_KEY]).toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'Discount code rejected: items_total_zero' }),
    )
    expect(JSON.parse((result as unknown as { error: string }).error).cause.code).toBe(DISCOUNT_REJECTED_CODE)
  })

  it('still accepts a code that leaves one cent of items', async () => {
    const ctx = setup({ discountDocs: [code({ type: 'fixed', value: 4999 })], settings: FLAT })
    const { passed } = await run(ctx, { body: { discountCode: 'SUMMER10' } })
    expect(passed?.data.cart.subtotal).toBe(1 + 599)
  })

  it('ignores shipping amounts and settings sent by the browser', async () => {
    const ctx = setup({ settings: FLAT })
    const { passed } = await run(ctx, {
      body: { flatShippingCents: 0, freeShippingThresholdCents: 1, shippingTotal: 0, total: 1 },
    })
    expect(passed?.data.cart.subtotal).toBe(5599)
  })

  it('saves a breakdown the transactions hook will accept, and charges exactly its total', async () => {
    const ctx = setup({ discountDocs: [code()], settings: FLAT })
    const { passed, req, result } = await run(ctx, { body: { discountCode: 'SUMMER10' } })

    const read = readPricingBreakdown(req.context)
    expect(read).not.toBeNull()
    expect(read).toEqual(pricingOf(result))
    expect(passed?.data.cart.subtotal).toBe(read?.total)
    expect(read?.total).toBe(read!.subtotal - read!.discountTotal + read!.shippingTotal)
  })

  it('reads the settings once per checkout, with the Local API', async () => {
    const ctx = setup({ discountDocs: [code()], settings: FLAT })
    await run(ctx, { body: { discountCode: 'SUMMER10' } })

    expect(ctx.payload.findGlobal).toHaveBeenCalledTimes(1)
    expect(ctx.payload.findGlobal).toHaveBeenCalledWith({
      depth: 0,
      overrideAccess: true,
      slug: 'site-settings',
    })
  })

  it('never reads the settings for a cart that is blocked', async () => {
    const ctx = setup({ products: { '1': publishedProduct({ inventory: 0 }) }, settings: FLAT })
    await expect(run(ctx)).rejects.toBeInstanceOf(CheckoutValidationError)
    expect(ctx.payload.findGlobal).not.toHaveBeenCalled()
  })

  describe('missing or invalid settings block checkout', () => {
    it.each([
      ['never saved', {}],
      ['null', null],
      ['a fractional flat rate', { flatShippingCents: 5.99, freeShippingThresholdCents: 7500 }],
      ['a zero threshold', { flatShippingCents: 599, freeShippingThresholdCents: 0 }],
      ['text amounts', { flatShippingCents: '599', freeShippingThresholdCents: '7500' }],
    ])('%s: throws, charges nothing, creates nothing', async (_name, settings) => {
      const ctx = setup({ discountDocs: [code()], settings })
      const req: Record<string, unknown> = {
        context: {},
        data: { discountCode: 'SUMMER10' },
        payload: ctx.payload,
      }

      await expect(run(ctx, { req })).rejects.toBeInstanceOf(ShippingSettingsError)

      expect(ctx.adapter.initiatePayment).not.toHaveBeenCalled()
      // The code is not even looked up: nothing is guessed while the settings are broken.
      expect(ctx.payload.find).not.toHaveBeenCalled()
      expect((req.context as Record<string, unknown>)[PRICING_CONTEXT_KEY]).toBeUndefined()
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          cartID: 42,
          msg: expect.stringContaining('Checkout blocked: Shipping settings are missing or invalid'),
        }),
      )
    })

    it('rethrows a database failure as it is, and does not call it a settings problem', async () => {
      const boom = new Error('connection terminated')
      const ctx = setup({ settingsError: boom })

      const error = await run(ctx).catch((e: unknown) => e)

      expect(error).toBe(boom)
      expect(error).not.toBeInstanceOf(ShippingSettingsError)
      expect(ctx.adapter.initiatePayment).not.toHaveBeenCalled()
      expect(ctx.logger.error).not.toHaveBeenCalled()
    })

    it('blocks checkout if shipping cannot be calculated, without a code', async () => {
      const ctx = setup({ settings: FLAT })
      const req: Record<string, unknown> = { context: {}, data: {}, payload: ctx.payload }
      shippingFailure.forced = true

      await expect(run(ctx, { req })).rejects.toThrow('Shipping could not be calculated.')

      expect(ctx.adapter.initiatePayment).not.toHaveBeenCalled()
      expect((req.context as Record<string, unknown>)[PRICING_CONTEXT_KEY]).toBeUndefined()
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'Checkout blocked: shipping could not be calculated (invalid_amount)',
        }),
      )
    })
  })
})