import { describe, expect, it, vi } from 'vitest'

import { getShippingSettings, ShippingSettingsError } from '@/pricing/getShippingSettings'

const makePayload = (impl: () => unknown) => {
  const findGlobal = vi.fn(async () => impl())
  return { payload: { findGlobal } as never, findGlobal }
}

describe('getShippingSettings', () => {
  it('returns parsed settings', async () => {
    const { payload } = makePayload(() => ({
      id: 1,
      flatShippingCents: 599,
      freeShippingThresholdCents: 7500,
      storeName: 'Cartwright',
    }))

    await expect(getShippingSettings(payload)).resolves.toEqual({
      flatShippingCents: 599,
      freeShippingThresholdCents: 7500,
    })
  })

  it('reads the site-settings global at depth 0 with access override', async () => {
    const { payload, findGlobal } = makePayload(() => ({
      flatShippingCents: 599,
      freeShippingThresholdCents: 7500,
    }))

    await getShippingSettings(payload)

    expect(findGlobal).toHaveBeenCalledTimes(1)
    expect(findGlobal).toHaveBeenCalledWith({
      slug: 'site-settings',
      depth: 0,
      overrideAccess: true,
    })
  })

  it.each([
    ['an unsaved global', {}],
    ['null', null],
    ['a fractional rate', { flatShippingCents: 5.99, freeShippingThresholdCents: 7500 }],
    ['a zero threshold', { flatShippingCents: 599, freeShippingThresholdCents: 0 }],
    ['a null rate', { flatShippingCents: null, freeShippingThresholdCents: 7500 }],
  ])('throws ShippingSettingsError for %s and never guesses defaults', async (_name, doc) => {
    const { payload } = makePayload(() => doc)
    await expect(getShippingSettings(payload)).rejects.toBeInstanceOf(ShippingSettingsError)
  })

  it('rethrows a database error as it is, not as a settings error', async () => {
    const boom = new Error('connection terminated')
    const { payload } = makePayload(() => {
      throw boom
    })

    const error = await getShippingSettings(payload).catch((e: unknown) => e)
    expect(error).toBe(boom)
    expect(error).not.toBeInstanceOf(ShippingSettingsError)
  })

  it('has a message that tells the admin what to do', () => {
    expect(new ShippingSettingsError().message).toMatch(/Site settings/)
  })
})