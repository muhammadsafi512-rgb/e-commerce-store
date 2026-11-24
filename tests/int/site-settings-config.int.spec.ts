import { describe, expect, it } from 'vitest'

import { SiteSettings } from '@/globals/SiteSettings'

type AnyField = {
  name?: string
  type?: string
  required?: boolean
  defaultValue?: unknown
  min?: number
  validate?: (value: unknown, options: never) => boolean | string | Promise<boolean | string>
}

const field = (name: string) => {
  const found = (SiteSettings.fields as AnyField[]).find((f) => f.name === name)
  if (!found) throw new Error(`field ${name} missing`)
  return found
}

const asUser = (roles: unknown) => ({ req: { user: roles === undefined ? null : { roles } } }) as never

const run = async (name: string, value: unknown) => await field(name).validate!(value, {} as never)

describe('site-settings global', () => {
  it('has the expected slug and fields', () => {
    expect(SiteSettings.slug).toBe('site-settings')
    expect(field('storeName').type).toBe('text')
    expect(field('flatShippingCents').type).toBe('number')
    expect(field('freeShippingThresholdCents').type).toBe('number')
  })

  it('requires both amounts and has the agreed defaults', () => {
    expect(field('flatShippingCents')).toMatchObject({ required: true, defaultValue: 599 })
    expect(field('freeShippingThresholdCents')).toMatchObject({ required: true, defaultValue: 7500 })
  })

  it('is admin-only for read and update', async () => {
    const read = SiteSettings.access!.read as (a: never) => boolean
    const update = SiteSettings.access!.update as (a: never) => boolean

    for (const access of [read, update]) {
      expect(access(asUser(['admin']))).toBe(true)
      expect(access(asUser(['customer', 'admin']))).toBe(true)
      expect(access(asUser(['customer']))).toBe(false)
      expect(access(asUser([]))).toBe(false)
      expect(access(asUser('admin'))).toBe(false)
      expect(access(asUser(undefined))).toBe(false)
    }
  })

  it('leaves no access operation open to the public', () => {
    const access = SiteSettings.access as Record<string, unknown>
    expect(Object.keys(access).sort()).toEqual(['read', 'update'])
  })

  it('accepts whole cents and rejects everything else', async () => {
    expect(await run('flatShippingCents', 0)).toBe(true)
    expect(await run('flatShippingCents', 599)).toBe(true)
    expect(typeof (await run('flatShippingCents', 5.99))).toBe('string')
    expect(typeof (await run('flatShippingCents', -1))).toBe('string')
    expect(typeof (await run('flatShippingCents', null))).toBe('string')
    expect(typeof (await run('flatShippingCents', 10_000_000))).toBe('string')

    expect(await run('freeShippingThresholdCents', 7500)).toBe(true)
    expect(typeof (await run('freeShippingThresholdCents', 0))).toBe('string')
    expect(typeof (await run('freeShippingThresholdCents', 75.5))).toBe('string')
    expect(typeof (await run('freeShippingThresholdCents', undefined))).toBe('string')
  })
})