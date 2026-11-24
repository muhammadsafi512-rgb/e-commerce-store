import { describe, expect, it } from 'vitest'

import { STRIPE_MIN_CHARGE_CENTS } from '../../src/pricing/constants'
import { computeDiscountTotal, evaluateDiscountCode } from '../../src/pricing/evaluateDiscountCode'
import type { ShippingSettings } from '../../src/pricing/shippingSettings'
import { normalizeDiscountCode } from '../../src/utilities/normalizeDiscountCode'

const NOW = new Date('2026-11-16T12:00:00.000Z')

/** Shipping off: every order ships for 0 cents. Keeps the tests about discounts alone. */
const NO_SHIPPING: ShippingSettings = { flatShippingCents: 0, freeShippingThresholdCents: 1 }

/** The agreed defaults: $5.99 flat, free from $75.00 (on the subtotal after the discount). */
const FLAT: ShippingSettings = { flatShippingCents: 599, freeShippingThresholdCents: 7500 }

const record = (overrides: Record<string, unknown> = {}) => ({
  active: true,
  code: 'SUMMER10',
  expiresAt: null,
  maxRedemptions: null,
  redemptions: 0,
  type: 'percent',
  value: 10,
  ...overrides,
})

const evaluate = (
  overrides: Record<string, unknown> = {},
  subtotal = 5000,
  extra: { shippingSettings?: ShippingSettings } = {},
) =>
  evaluateDiscountCode({
    now: NOW,
    record: record(overrides),
    shippingSettings: NO_SHIPPING,
    subtotal,
    ...extra,
  })

describe('normalizeDiscountCode', () => {
  it('trims and uppercases', () => {
    expect(normalizeDiscountCode('  summer10 ')).toBe('SUMMER10')
    expect(normalizeDiscountCode('Summer-10')).toBe('SUMMER-10')
  })

  it('returns null for empty, whitespace and non-strings', () => {
    expect(normalizeDiscountCode('')).toBeNull()
    expect(normalizeDiscountCode('   ')).toBeNull()
    expect(normalizeDiscountCode(undefined)).toBeNull()
    expect(normalizeDiscountCode(null)).toBeNull()
    expect(normalizeDiscountCode(10)).toBeNull()
    expect(normalizeDiscountCode({})).toBeNull()
  })
})

describe('computeDiscountTotal', () => {
  it('rounds percent discounts down', () => {
    expect(computeDiscountTotal({ type: 'percent', value: 10 }, 5000)).toBe(500)
    expect(computeDiscountTotal({ type: 'percent', value: 15 }, 999)).toBe(149) // 149.85 -> 149
    expect(computeDiscountTotal({ type: 'percent', value: 1 }, 99)).toBe(0)
  })

  it('takes a fixed amount off, capped at the subtotal', () => {
    expect(computeDiscountTotal({ type: 'fixed', value: 500 }, 5000)).toBe(500)
    expect(computeDiscountTotal({ type: 'fixed', value: 9000 }, 5000)).toBe(5000)
  })
})

describe('evaluateDiscountCode: accepted codes', () => {
  it('applies a percent code', () => {
    expect(evaluate()).toEqual({
      code: 'SUMMER10',
      discountTotal: 500,
      ok: true,
      shippingTotal: 0,
      total: 4500,
      type: 'percent',
      value: 10,
    })
  })

  it('applies a fixed code', () => {
    expect(evaluate({ type: 'fixed', value: 700 })).toMatchObject({
      discountTotal: 700,
      ok: true,
      total: 4300,
    })
  })

  it('adds shipping to the total after the discount', () => {
    expect(evaluate({}, 5000, { shippingSettings: FLAT })).toMatchObject({
      discountTotal: 500,
      ok: true,
      shippingTotal: 599,
      total: 5099,
    })
  })

  it('accepts exactly the Stripe minimum', () => {
    // 5000 - 4950 = 50
    expect(evaluate({ type: 'fixed', value: 4950 })).toMatchObject({ ok: true, total: 50 })
    expect(STRIPE_MIN_CHARGE_CENTS).toBe(50)
  })

  it('accepts a code that leaves one cent of items when shipping covers the minimum', () => {
    // items 1 + shipping 599 = 600
    expect(evaluate({ type: 'fixed', value: 4999 }, 5000, { shippingSettings: FLAT })).toMatchObject({
      discountTotal: 4999,
      ok: true,
      shippingTotal: 599,
      total: 600,
    })
  })

  it('accepts a code with a future expiry and room left', () => {
    expect(
      evaluate({ expiresAt: '2026-11-17T00:00:00.000Z', maxRedemptions: 5, redemptions: 4 }).ok,
    ).toBe(true)
  })

  it('treats a missing redemptions counter as 0', () => {
    expect(evaluate({ maxRedemptions: 1, redemptions: undefined }).ok).toBe(true)
  })
})

describe('evaluateDiscountCode: free shipping is decided after the discount', () => {
  it('is free when the discounted subtotal is exactly the threshold', () => {
    // 8000 - 500 = 7500
    expect(evaluate({ type: 'fixed', value: 500 }, 8000, { shippingSettings: FLAT })).toMatchObject({
      ok: true,
      shippingTotal: 0,
      total: 7500,
    })
  })

  it('charges shipping when the discount leaves it one cent under the threshold', () => {
    // 8000 - 501 = 7499
    expect(evaluate({ type: 'fixed', value: 501 }, 8000, { shippingSettings: FLAT })).toMatchObject({
      ok: true,
      shippingTotal: 599,
      total: 8098,
    })
  })

  it('charges shipping when the code drops a cart that was over the threshold under it', () => {
    // 8000 is over 7500, but 8000 - 800 = 7200 is not
    expect(evaluate({}, 8000, { shippingSettings: FLAT })).toMatchObject({
      discountTotal: 800,
      ok: true,
      shippingTotal: 599,
      total: 7799,
    })
  })

  it('stays free when the discounted subtotal is still over the threshold', () => {
    // 8000 - 400 = 7600
    expect(evaluate({ value: 5 }, 8000, { shippingSettings: FLAT })).toMatchObject({
      discountTotal: 400,
      ok: true,
      shippingTotal: 0,
      total: 7600,
    })
  })
})

describe('evaluateDiscountCode: rejected codes', () => {
  it('rejects an inactive code', () => {
    expect(evaluate({ active: false })).toEqual({ ok: false, reason: 'inactive' })
  })

  it('treats anything but active === true as inactive', () => {
    expect(evaluate({ active: undefined })).toEqual({ ok: false, reason: 'inactive' })
    expect(evaluate({ active: 'true' })).toEqual({ ok: false, reason: 'inactive' })
  })

  it('rejects an expired code, including the exact expiry moment', () => {
    expect(evaluate({ expiresAt: '2026-11-16T11:59:59.999Z' })).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(evaluate({ expiresAt: NOW.toISOString() })).toEqual({ ok: false, reason: 'expired' })
  })

  it('accepts expiresAt as a Date or a timestamp', () => {
    expect(evaluate({ expiresAt: new Date('2026-11-16T12:00:00.001Z') }).ok).toBe(true)
    expect(evaluate({ expiresAt: NOW.getTime() })).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects when the redemption limit is reached or passed', () => {
    expect(evaluate({ maxRedemptions: 5, redemptions: 5 })).toEqual({
      ok: false,
      reason: 'exhausted',
    })
    expect(evaluate({ maxRedemptions: 5, redemptions: 7 })).toEqual({
      ok: false,
      reason: 'exhausted',
    })
  })

  it('rejects a total below the Stripe minimum', () => {
    // 5000 - 4951 = 49
    expect(evaluate({ type: 'fixed', value: 4951 })).toEqual({ ok: false, reason: 'below_minimum' })
  })

  it('rejects a code that leaves one cent when shipping does not lift the total to the minimum', () => {
    expect(evaluate({ type: 'fixed', value: 4999 })).toEqual({ ok: false, reason: 'below_minimum' })
  })

  it('rejects a percent code that leaves less than the minimum', () => {
    expect(evaluate({ value: 99 }, 100)).toEqual({ ok: false, reason: 'below_minimum' })
  })

  it('rejects any code on a cart that is already below the minimum', () => {
    expect(evaluate({}, 40)).toEqual({ ok: false, reason: 'below_minimum' })
  })

  it('counts shipping toward the minimum', () => {
    // items 1 + shipping 49 = 50 (accepted); items 1 + shipping 48 = 49 (rejected)
    expect(
      evaluate({ type: 'fixed', value: 4999 }, 5000, {
        shippingSettings: { flatShippingCents: 49, freeShippingThresholdCents: 7500 },
      }),
    ).toMatchObject({ ok: true, total: 50 })
    expect(
      evaluate({ type: 'fixed', value: 4999 }, 5000, {
        shippingSettings: { flatShippingCents: 48, freeShippingThresholdCents: 7500 },
      }),
    ).toEqual({ ok: false, reason: 'below_minimum' })
  })
})

describe('evaluateDiscountCode: the items never go to zero (decision #41)', () => {
  it('rejects a fixed code that takes exactly the whole subtotal', () => {
    expect(evaluate({ type: 'fixed', value: 5000 })).toEqual({ ok: false, reason: 'items_total_zero' })
  })

  it('rejects a fixed code bigger than the cart', () => {
    expect(evaluate({ type: 'fixed', value: 9000 })).toEqual({ ok: false, reason: 'items_total_zero' })
  })

  it('rejects it even when shipping would keep the total above the Stripe minimum', () => {
    // 0 of items + 599 shipping = 599, well over 50. Still rejected: free goods, paid shipping.
    expect(evaluate({ type: 'fixed', value: 5000 }, 5000, { shippingSettings: FLAT })).toEqual({
      ok: false,
      reason: 'items_total_zero',
    })
    expect(evaluate({ type: 'fixed', value: 9000 }, 5000, { shippingSettings: FLAT })).toEqual({
      ok: false,
      reason: 'items_total_zero',
    })
  })

  it('is judged per cart: the same code is fine on a bigger cart', () => {
    expect(evaluate({ type: 'fixed', value: 5000 }, 9000)).toMatchObject({ ok: true, total: 4000 })
  })

  it('does not reject a percent code on a tiny cart (it rounds down, so something is left)', () => {
    // 99% of 50 = 49.5 -> 49, leaving 1
    expect(evaluate({ value: 99 }, 50, { shippingSettings: FLAT })).toMatchObject({
      discountTotal: 49,
      ok: true,
      total: 600,
    })
  })
})

describe('evaluateDiscountCode: fails closed on a bad stored record', () => {
  it('rejects 100% and out-of-range percent values', () => {
    expect(evaluate({ value: 100 })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ value: 150 })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ value: 0 })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ value: -10 })).toEqual({ ok: false, reason: 'invalid_definition' })
  })

  it('rejects fractional and non-numeric values', () => {
    expect(evaluate({ value: 10.5 })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ type: 'fixed', value: 5.5 })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ value: '10' })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ value: Number.NaN })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ value: null })).toEqual({ ok: false, reason: 'invalid_definition' })
  })

  it('rejects an unknown type and a bad code', () => {
    expect(evaluate({ type: 'bogus' })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ code: '' })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ code: 5 })).toEqual({ ok: false, reason: 'invalid_definition' })
  })

  it('rejects an unparseable or wrong-typed expiry', () => {
    expect(evaluate({ expiresAt: 'not a date' })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ expiresAt: {} })).toEqual({ ok: false, reason: 'invalid_definition' })
  })

  it('rejects a bad maxRedemptions or redemptions counter', () => {
    expect(evaluate({ maxRedemptions: 0 })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ maxRedemptions: 2.5 })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ redemptions: -1 })).toEqual({ ok: false, reason: 'invalid_definition' })
    expect(evaluate({ redemptions: 1.5 })).toEqual({ ok: false, reason: 'invalid_definition' })
  })

  it('rejects records that are not objects', () => {
    for (const bad of [null, undefined, 'SUMMER10', 5, [], true]) {
      expect(
        evaluateDiscountCode({ now: NOW, record: bad, shippingSettings: NO_SHIPPING, subtotal: 5000 }),
      ).toEqual({
        ok: false,
        reason: 'invalid_definition',
      })
    }
  })

  it('rejects bad amounts from the caller', () => {
    const bad = (subtotal: number) =>
      evaluateDiscountCode({ now: NOW, record: record(), shippingSettings: NO_SHIPPING, subtotal })
    expect(bad(0)).toEqual({ ok: false, reason: 'invalid_amount' })
    expect(bad(-100)).toEqual({ ok: false, reason: 'invalid_amount' })
    expect(bad(10.5)).toEqual({ ok: false, reason: 'invalid_amount' })
    expect(bad(Number.NaN)).toEqual({ ok: false, reason: 'invalid_amount' })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['a fractional flat rate', { flatShippingCents: 5.99, freeShippingThresholdCents: 7500 }],
    ['a negative flat rate', { flatShippingCents: -1, freeShippingThresholdCents: 7500 }],
    ['a zero threshold', { flatShippingCents: 599, freeShippingThresholdCents: 0 }],
    ['a missing threshold', { flatShippingCents: 599 }],
  ])('rejects the code when the shipping settings are %s, and guesses nothing', (_name, bad) => {
    expect(
      evaluateDiscountCode({
        now: NOW,
        record: record(),
        shippingSettings: bad as never,
        subtotal: 5000,
      }),
    ).toEqual({ ok: false, reason: 'invalid_settings' })
  })

  it('never returns a total below the minimum, items at zero or a wrong shipping amount when ok', () => {
    for (const settings of [NO_SHIPPING, FLAT]) {
      for (const subtotal of [50, 51, 99, 100, 999, 5000, 7499, 7500, 7501, 8000, 123_457]) {
        for (const value of [1, 10, 33, 50, 99]) {
          for (const type of ['percent', 'fixed']) {
            const r = evaluate({ type, value: type === 'fixed' ? value * 100 : value }, subtotal, {
              shippingSettings: settings,
            })
            if (r.ok) {
              const items = subtotal - r.discountTotal
              expect(r.total).toBeGreaterThanOrEqual(STRIPE_MIN_CHARGE_CENTS)
              expect(items).toBeGreaterThan(0)
              expect(Number.isInteger(r.discountTotal)).toBe(true)
              expect(r.shippingTotal).toBe(
                items >= settings.freeShippingThresholdCents ? 0 : settings.flatShippingCents,
              )
              expect(r.total).toBe(items + r.shippingTotal)
            }
          }
        }
      }
    }
  })
})