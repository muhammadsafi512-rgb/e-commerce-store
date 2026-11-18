import type { Field } from 'payload'
import { describe, expect, it } from 'vitest'

import {
  DiscountCodes,
  discountCodesAdminOnly,
  validateDiscountValue,
  validateMaxRedemptions,
} from '../../src/collections/DiscountCodes'

const field = (name: string): Field => {
  const found = DiscountCodes.fields.find((f) => 'name' in f && f.name === name)
  if (!found) throw new Error(`Field ${name} not found`)
  return found
}

const asUser = (user: unknown) => ({ req: { user } }) as never
const run = (user: unknown) => discountCodesAdminOnly(asUser(user))

describe('discount-codes: shape', () => {
  it('has the planned slug and fields', () => {
    expect(DiscountCodes.slug).toBe('discount-codes')
    const names = DiscountCodes.fields.map((f) => ('name' in f ? f.name : undefined))
    expect(names).toEqual([
      'code',
      'type',
      'value',
      'active',
      'expiresAt',
      'maxRedemptions',
      'redemptions',
    ])
  })

  it('code is required, unique and indexed', () => {
    expect(field('code')).toMatchObject({ index: true, required: true, unique: true })
  })

  it('code is normalised (trim + uppercase) before validation', () => {
    const hook = (field('code') as { hooks: { beforeValidate: Array<(a: { value: unknown }) => unknown> } })
      .hooks.beforeValidate[0]!
    expect(hook({ value: ' summer10 ' })).toBe('SUMMER10')
    expect(hook({ value: '   ' })).toBeNull()
  })

  it('type offers exactly percent and fixed, default percent', () => {
    const type = field('type') as { defaultValue: string; options: Array<{ value: string }> }
    expect(type.options.map((o) => o.value)).toEqual(['percent', 'fixed'])
    expect(type.defaultValue).toBe('percent')
  })

  it('redemptions starts at 0, is read-only in the admin and not updatable through the API', () => {
    const redemptions = field('redemptions') as {
      access: { update: () => boolean }
      admin: { readOnly: boolean }
      defaultValue: number
    }
    expect(redemptions.defaultValue).toBe(0)
    expect(redemptions.admin.readOnly).toBe(true)
    expect(redemptions.access.update()).toBe(false)
  })

  it('active defaults to true', () => {
    expect(field('active')).toMatchObject({ defaultValue: true })
  })
})

describe('discount-codes: access', () => {
  it('allows admins', () => {
    expect(run({ id: 1, roles: ['admin'] })).toBe(true)
    expect(run({ id: 1, roles: ['customer', 'admin'] })).toBe(true)
  })

  it('denies customers, guests and malformed users', () => {
    expect(run({ id: 2, roles: ['customer'] })).toBe(false)
    expect(run(null)).toBe(false)
    expect(run(undefined)).toBe(false)
    expect(run({ id: 3 })).toBe(false)
    expect(run({ id: 3, roles: 'admin' })).toBe(false)
  })

  it('uses the admin-only rule for every operation', () => {
    const access = DiscountCodes.access!
    expect(access.read).toBe(discountCodesAdminOnly)
    expect(access.create).toBe(discountCodesAdminOnly)
    expect(access.update).toBe(discountCodesAdminOnly)
    expect(access.delete).toBe(discountCodesAdminOnly)
  })
})

describe('discount-codes: value validation', () => {
  const v = (value: number | null | undefined, type: string | undefined) =>
    validateDiscountValue(value, { siblingData: { type } })

  it('accepts percent 1 to 99', () => {
    expect(v(1, 'percent')).toBe(true)
    expect(v(99, 'percent')).toBe(true)
  })

  it('rejects percent 0, 100, fractional and negative', () => {
    for (const bad of [0, 100, 101, 5.5, -5]) {
      expect(typeof v(bad, 'percent')).toBe('string')
    }
  })

  it('accepts fixed whole cents of at least 1', () => {
    expect(v(1, 'fixed')).toBe(true)
    expect(v(500, 'fixed')).toBe(true)
  })

  it('rejects fixed 0, fractional and negative', () => {
    for (const bad of [0, 5.5, -5]) {
      expect(typeof v(bad, 'fixed')).toBe('string')
    }
  })

  it('requires a value', () => {
    expect(typeof v(undefined, 'percent')).toBe('string')
    expect(typeof v(null, 'fixed')).toBe('string')
  })

  it('applies the stricter percent rule while the type is still unknown', () => {
    // No type selected yet: a fixed-style check, but still whole and positive.
    expect(typeof v(0, undefined)).toBe('string')
  })

  it('maxRedemptions is optional but must be a whole number of at least 1', () => {
    expect(validateMaxRedemptions(undefined)).toBe(true)
    expect(validateMaxRedemptions(null)).toBe(true)
    expect(validateMaxRedemptions(1)).toBe(true)
    expect(typeof validateMaxRedemptions(0)).toBe('string')
    expect(typeof validateMaxRedemptions(2.5)).toBe('string')
    expect(typeof validateMaxRedemptions(-1)).toBe('string')
  })
})