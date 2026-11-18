import { describe, expect, it } from 'vitest'

import { STRIPE_MIN_CHARGE_CENTS } from '../../src/pricing/constants'
import { computeDiscountTotal, evaluateDiscountCode } from '../../src/pricing/evaluateDiscountCode'
import { normalizeDiscountCode } from '../../src/utilities/normalizeDiscountCode'

const NOW = new Date('2026-11-16T12:00:00.000Z')

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
  extra: { shippingTotal?: number } = {},
) => evaluateDiscountCode({ now: NOW, record: record(overrides), subtotal, ...extra })

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
    expect(evaluate({}, 5000, { shippingTotal: 599 })).toMatchObject({
      discountTotal: 500,
      ok: true,
      total: 5099,
    })
  })

  it('accepts exactly the Stripe minimum', () => {
    // 5000 - 4950 = 50
    expect(evaluate({ type: 'fixed', value: 4950 })).toMatchObject({ ok: true, total: 50 })
    expect(STRIPE_MIN_CHARGE_CENTS).toBe(50)
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

  it('rejects a fixed code bigger than the cart', () => {
    expect(evaluate({ type: 'fixed', value: 9000 })).toEqual({ ok: false, reason: 'below_minimum' })
  })

  it('rejects a percent code that leaves less than the minimum', () => {
    expect(evaluate({ value: 99 }, 100)).toEqual({ ok: false, reason: 'below_minimum' })
  })

  it('rejects any code on a cart that is already below the minimum', () => {
    expect(evaluate({}, 40)).toEqual({ ok: false, reason: 'below_minimum' })
  })

  it('counts shipping toward the minimum', () => {
    expect(evaluate({ type: 'fixed', value: 5000 }, 5000, { shippingTotal: 50 })).toMatchObject({
      discountTotal: 5000,
      ok: true,
      total: 50,
    })
    expect(evaluate({ type: 'fixed', value: 5000 }, 5000, { shippingTotal: 49 })).toEqual({
      ok: false,
      reason: 'below_minimum',
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
      expect(evaluateDiscountCode({ now: NOW, record: bad, subtotal: 5000 })).toEqual({
        ok: false,
        reason: 'invalid_definition',
      })
    }
  })

  it('rejects bad amounts from the caller', () => {
    const bad = (subtotal: number, shippingTotal?: number) =>
      evaluateDiscountCode({ now: NOW, record: record(), shippingTotal, subtotal })
    expect(bad(0)).toEqual({ ok: false, reason: 'invalid_amount' })
    expect(bad(-100)).toEqual({ ok: false, reason: 'invalid_amount' })
    expect(bad(10.5)).toEqual({ ok: false, reason: 'invalid_amount' })
    expect(bad(Number.NaN)).toEqual({ ok: false, reason: 'invalid_amount' })
    expect(bad(5000, -1)).toEqual({ ok: false, reason: 'invalid_amount' })
    expect(bad(5000, 1.5)).toEqual({ ok: false, reason: 'invalid_amount' })
  })

  it('never returns a total below the minimum or a discount above the subtotal when ok', () => {
    for (const subtotal of [50, 51, 99, 100, 999, 5000, 123_457]) {
      for (const value of [1, 10, 33, 50, 99]) {
        const r = evaluate({ value }, subtotal)
        if (r.ok) {
          expect(r.total).toBeGreaterThanOrEqual(STRIPE_MIN_CHARGE_CENTS)
          expect(r.discountTotal).toBeLessThanOrEqual(subtotal)
          expect(Number.isInteger(r.discountTotal)).toBe(true)
          expect(r.total).toBe(subtotal - r.discountTotal)
        }
      }
    }
  })
})