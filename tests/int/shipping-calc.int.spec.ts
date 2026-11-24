import { describe, expect, it } from 'vitest'

import {
  DEFAULT_FLAT_SHIPPING_CENTS,
  DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS,
  MAX_SHIPPING_SETTINGS_CENTS,
  isWholeCents,
  parseShippingSettings,
} from '@/pricing/shippingSettings'
import { calculateShipping } from '@/pricing/calculateShipping'

const settings = { flatShippingCents: 599, freeShippingThresholdCents: 7500 }

describe('isWholeCents', () => {
  it('accepts whole numbers inside the range', () => {
    expect(isWholeCents(0, 0)).toBe(true)
    expect(isWholeCents(599, 0)).toBe(true)
    expect(isWholeCents(MAX_SHIPPING_SETTINGS_CENTS, 0)).toBe(true)
  })

  it('respects the minimum', () => {
    expect(isWholeCents(0, 1)).toBe(false)
    expect(isWholeCents(1, 1)).toBe(true)
  })

  it('rejects fractions, negatives, too large, NaN, Infinity and non-numbers', () => {
    expect(isWholeCents(5.99, 0)).toBe(false)
    expect(isWholeCents(-1, 0)).toBe(false)
    expect(isWholeCents(MAX_SHIPPING_SETTINGS_CENTS + 1, 0)).toBe(false)
    expect(isWholeCents(Number.NaN, 0)).toBe(false)
    expect(isWholeCents(Number.POSITIVE_INFINITY, 0)).toBe(false)
    expect(isWholeCents('599', 0)).toBe(false)
    expect(isWholeCents(null, 0)).toBe(false)
    expect(isWholeCents(undefined, 0)).toBe(false)
  })
})

describe('parseShippingSettings', () => {
  it('returns valid settings', () => {
    expect(parseShippingSettings(settings)).toEqual(settings)
  })

  it('ignores extra fields such as id and storeName', () => {
    expect(parseShippingSettings({ ...settings, id: 1, storeName: 'Cartwright' })).toEqual(settings)
  })

  it('allows a flat rate of 0 but not a threshold of 0', () => {
    expect(parseShippingSettings({ ...settings, flatShippingCents: 0 })).not.toBeNull()
    expect(parseShippingSettings({ ...settings, freeShippingThresholdCents: 0 })).toBeNull()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['an empty object', {}],
    ['a missing flat rate', { freeShippingThresholdCents: 7500 }],
    ['a missing threshold', { flatShippingCents: 599 }],
    ['a null flat rate', { ...settings, flatShippingCents: null }],
    ['a fractional flat rate', { ...settings, flatShippingCents: 5.99 }],
    ['a negative flat rate', { ...settings, flatShippingCents: -1 }],
    ['text amounts', { flatShippingCents: '599', freeShippingThresholdCents: '7500' }],
    ['a huge threshold', { ...settings, freeShippingThresholdCents: MAX_SHIPPING_SETTINGS_CENTS + 1 }],
  ])('returns null for %s', (_name, value) => {
    expect(parseShippingSettings(value)).toBeNull()
  })

  it('has admin defaults that are themselves valid', () => {
    expect(
      parseShippingSettings({
        flatShippingCents: DEFAULT_FLAT_SHIPPING_CENTS,
        freeShippingThresholdCents: DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS,
      }),
    ).not.toBeNull()
    expect(DEFAULT_FLAT_SHIPPING_CENTS).toBe(599)
    expect(DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS).toBe(7500)
  })
})

describe('calculateShipping', () => {
  it('charges the flat rate under the threshold', () => {
    expect(calculateShipping({ discountedSubtotal: 7499, settings })).toEqual({
      ok: true,
      shippingTotal: 599,
      free: false,
    })
  })

  it('is free exactly at the threshold', () => {
    expect(calculateShipping({ discountedSubtotal: 7500, settings })).toEqual({
      ok: true,
      shippingTotal: 0,
      free: true,
    })
  })

  it('is free above the threshold', () => {
    expect(calculateShipping({ discountedSubtotal: 100_000, settings })).toMatchObject({
      ok: true,
      shippingTotal: 0,
    })
  })

  it('charges shipping on a zero subtotal (the caller decides if that is allowed)', () => {
    expect(calculateShipping({ discountedSubtotal: 0, settings })).toMatchObject({
      ok: true,
      shippingTotal: 599,
    })
  })

  it('reports free when the flat rate itself is 0', () => {
    expect(
      calculateShipping({
        discountedSubtotal: 100,
        settings: { ...settings, flatShippingCents: 0 },
      }),
    ).toEqual({ ok: true, shippingTotal: 0, free: true })
  })

  it.each([-1, 10.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'rejects the amount %s',
    (discountedSubtotal) => {
      expect(calculateShipping({ discountedSubtotal, settings })).toEqual({
        ok: false,
        reason: 'invalid_amount',
      })
    },
  )

  it('rejects an amount that is not a number', () => {
    expect(
      calculateShipping({ discountedSubtotal: '7500' as unknown as number, settings }),
    ).toEqual({ ok: false, reason: 'invalid_amount' })
  })

  it.each([
    ['fractional flat rate', { flatShippingCents: 5.99, freeShippingThresholdCents: 7500 }],
    ['negative flat rate', { flatShippingCents: -1, freeShippingThresholdCents: 7500 }],
    ['zero threshold', { flatShippingCents: 599, freeShippingThresholdCents: 0 }],
    ['missing threshold', { flatShippingCents: 599 }],
    ['null settings', null],
  ])('rejects %s without guessing', (_name, bad) => {
    expect(
      calculateShipping({ discountedSubtotal: 5000, settings: bad as never }),
    ).toEqual({ ok: false, reason: 'invalid_settings' })
  })

  it('does not change its input', () => {
    const frozen = Object.freeze({ ...settings })
    expect(() => calculateShipping({ discountedSubtotal: 5000, settings: frozen })).not.toThrow()
  })
})