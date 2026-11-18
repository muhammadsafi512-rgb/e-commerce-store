import { describe, expect, it, vi } from 'vitest'

import {
  DISCOUNT_REJECTED_CODE,
  DISCOUNT_REJECTED_MESSAGE,
  withCheckoutValidation,
} from '../../src/payments/withCheckoutValidation'
import { CheckoutValidationError } from '../../src/payments/validateCheckoutCart'
import { PRICING_CONTEXT_KEY } from '../../src/pricing/pricingBreakdown'


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
}: { discountDocs?: unknown[]; findError?: Error; products?: Record<string, unknown> } = {}) => {
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
  { body, cartSubtotal = 5000 }: { body?: Record<string, unknown> | undefined; cartSubtotal?: number } = {},
) => {
  const items = [{ product: 1, quantity: 1 }]
  const req: Record<string, unknown> = { context: {}, data: body, payload: ctx.payload }
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
  ])('%s: charges the database total, looks nothing up, returns the adapter response untouched', async (_name, body) => {
    const ctx = setup({ discountDocs: [code()] })
    const { passed, req, result } = await run(ctx, { body: body as Record<string, unknown> | undefined })

    expect(ctx.payload.find).not.toHaveBeenCalled()
    expect(passed?.data.cart.subtotal).toBe(5000)
    expect(result).toBe(ctx.response)
    expect((req.context as Record<string, unknown>)[PRICING_CONTEXT_KEY]).toEqual({
      discountCode: null,
      discountTotal: 0,
      shippingTotal: 0,
      subtotal: 5000,
      total: 5000,
    })
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