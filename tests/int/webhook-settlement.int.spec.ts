import { describe, expect, it, vi } from 'vitest'

import { createPaymentIntentSucceededHandler } from '@/payments/settlement/paymentIntentSucceded'

/**
 * Pure unit tests with a fake Payload (no database). They pin the webhook's behaviour:
 * one order + one decrement per paid transaction, nothing written on mismatch, never a
 * second order on retry.
 */

const ITEMS = [{ product: 5, quantity: 2, variant: 9 }]

const makeTransaction = (over: Record<string, unknown> = {}) => ({
  amount: 4000,
  cart: 3,
  currency: 'USD',
  customer: 7,
  id: 11,
  items: ITEMS,
  status: 'pending',
  stripe: { customerID: 'cus_1', paymentIntentID: 'pi_1' },
  ...over,
})

const makePI = (over: Record<string, unknown> = {}) => ({
  amount: 4000,
  currency: 'usd',
  customer: 'cus_1',
  id: 'pi_1',
  metadata: {
    cartID: '3',
    cartItemsSnapshot: JSON.stringify(ITEMS),
    shippingAddress: JSON.stringify({ city: 'X' }),
  },
  status: 'succeeded',
  ...over,
})

const setup = ({
  claim = true as boolean,
  transaction = makeTransaction() as Record<string, unknown> | null,
  pi = makePI() as unknown,
  throwOnCreate = false,
} = {}) => {
  const calls: string[] = []
  const updateOne = vi.fn(async (args: { collection: string }) => {
    calls.push(`updateOne:${args.collection}`)
    return args.collection === 'transactions' && !claim ? null : { id: 1 }
  })
  const payload = {
    create: vi.fn(async () => {
      calls.push('create:order')
      if (throwOnCreate) throw new Error('db down')
      return { id: 99 }
    }),
    db: { updateOne },
    find: vi.fn(async (args: { collection: string }) =>
      args.collection === 'transactions'
        ? { docs: transaction ? [transaction] : [], totalDocs: transaction ? 1 : 0 }
        : { docs: [], totalDocs: 0 },
    ),
    findByID: vi.fn(async () => (transaction ? { ...transaction, status: 'processing' } : null)),
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    update: vi.fn(async (args: { collection: string }) => {
      calls.push(`update:${args.collection}`)
      return {}
    }),
  }
  const deps = {
    commitTransaction: vi.fn(async () => {}),
    initTransaction: vi.fn(async () => true),
    killTransaction: vi.fn(async () => {}),
  }
  const stripe = { paymentIntents: { retrieve: vi.fn(async () => pi) } }
  const handler = createPaymentIntentSucceededHandler(deps)
  const run = () =>
    handler({
      event: { data: { object: { id: 'pi_1' } } },
      req: { payload } as never,
      stripe: stripe as never,
    })

  return { calls, deps, payload, run, stripe, updateOne }
}

describe('payment_intent.succeeded webhook', () => {
  it('settles: claim, order, cart, decrement, transaction succeeded, commit', async () => {
    const t = setup()
    await t.run()

    expect(t.calls).toEqual([
      'updateOne:transactions',
      'create:order',
      'update:carts',
      'updateOne:variants',
      'update:transactions',
    ])
    expect(t.deps.commitTransaction).toHaveBeenCalledTimes(1)
    expect(t.deps.killTransaction).not.toHaveBeenCalled()

    const dec = t.updateOne.mock.calls.find((c) => c[0].collection === 'variants')![0] as unknown as {
      data: unknown
      id: unknown
    }
    expect(dec.id).toBe(9)
    expect(dec.data).toEqual({ inventory: { $inc: -2 } })
  })

  it('builds the order from the transaction and Stripe metadata (logged-in customer)', async () => {
    const t = setup()
    await t.run()
    const data = (t.payload.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data

    expect(data).toMatchObject({
      amount: 4000,
      currency: 'USD',
      customer: 7,
      items: ITEMS,
      shippingAddress: { city: 'X' },
      status: 'processing',
      transactions: [11],
    })
    expect(data).not.toHaveProperty('customerEmail')
  })

  it('uses customerEmail for guests', async () => {
    const t = setup({ transaction: makeTransaction({ customer: null, customerEmail: ' Guest@Example.com ' }) })
    await t.run()
    const data = (t.payload.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data

    expect(data.customerEmail).toBe('guest@example.com')
    expect(data).not.toHaveProperty('customer')
  })

  it('does nothing when the transaction is already succeeded (browser path won)', async () => {
    const t = setup({ transaction: makeTransaction({ status: 'succeeded' }) })
    await t.run()

    expect(t.stripe.paymentIntents.retrieve).not.toHaveBeenCalled()
    expect(t.payload.create).not.toHaveBeenCalled()
    expect(t.deps.initTransaction).not.toHaveBeenCalled()
  })

  it('returns without error when the claim is lost, and creates nothing', async () => {
    const t = setup({ claim: false })
    await t.run()

    expect(t.payload.create).not.toHaveBeenCalled()
    expect(t.deps.commitTransaction).toHaveBeenCalledTimes(1)
  })

  it('ignores an unknown PaymentIntent (200, no writes)', async () => {
    const t = setup({ transaction: null })
    await t.run()

    expect(t.payload.create).not.toHaveBeenCalled()
    expect(t.stripe.paymentIntents.retrieve).not.toHaveBeenCalled()
  })

  it('double delivery creates one order and one decrement', async () => {
    // Second delivery sees the transaction already succeeded.
    const first = setup()
    await first.run()
    const second = setup({ transaction: makeTransaction({ status: 'succeeded' }) })
    await second.run()

    expect(first.payload.create).toHaveBeenCalledTimes(1)
    expect(second.payload.create).not.toHaveBeenCalled()
    expect(second.updateOne).not.toHaveBeenCalled()
  })

  describe('throws (Stripe retries) and writes nothing on', () => {
    const cases: Array<[string, Parameters<typeof setup>[0]]> = [
      ['amount mismatch', { pi: makePI({ amount: 1 }) }],
      ['currency mismatch', { pi: makePI({ currency: 'eur' }) }],
      ['cart mismatch', { pi: makePI({ metadata: { cartID: '4', cartItemsSnapshot: JSON.stringify(ITEMS) } }) }],
      ['items mismatch', { pi: makePI({ metadata: { cartID: '3', cartItemsSnapshot: JSON.stringify([{ product: 5, quantity: 3, variant: 9 }]) } }) }],
      ['stripe customer mismatch', { pi: makePI({ customer: 'cus_other' }) }],
      ['payment intent not succeeded', { pi: makePI({ status: 'processing' }) }],
      ['missing items metadata', { pi: makePI({ metadata: { cartID: '3' } }) }],
      ['bad JSON metadata', { pi: makePI({ metadata: { cartID: '3', cartItemsSnapshot: '{nope' } }) }],
      ['transaction in an unexpected status', { transaction: makeTransaction({ status: 'failed' }) }],
      ['no purchaser on the transaction', { transaction: makeTransaction({ customer: null }) }],
    ]

    it.each(cases)('%s', async (_name, opts) => {
      const t = setup(opts)
      await expect(t.run()).rejects.toThrow()

      expect(t.payload.create).not.toHaveBeenCalled()
      expect(t.updateOne).not.toHaveBeenCalled()
      expect(t.deps.initTransaction).not.toHaveBeenCalled()
    })
  })

  it('rolls back and rethrows when settlement fails midway', async () => {
    const t = setup({ throwOnCreate: true })
    await expect(t.run()).rejects.toThrow('db down')

    expect(t.deps.killTransaction).toHaveBeenCalledTimes(1)
    expect(t.deps.commitTransaction).not.toHaveBeenCalled()
  })

  it('does not commit or kill a transaction it did not start', async () => {
    const t = setup()
    t.deps.initTransaction.mockResolvedValue(false)
    await t.run()

    expect(t.deps.commitTransaction).not.toHaveBeenCalled()
    expect(t.deps.killTransaction).not.toHaveBeenCalled()
  })
})