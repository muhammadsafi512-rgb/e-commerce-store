/**
 * Reads the shipping settings for checkout.
 *
 * Fails closed: a missing, unsaved or malformed global throws, so checkout is blocked
 * (nothing is charged and no transaction exists) instead of guessing a shipping price.
 * Database errors are rethrown as they are. Use it only before payment (the checkout
 * wrapper), never during settlement.
 */

import type { Payload } from 'payload'

import { parseShippingSettings, type ShippingSettings } from './shippingSettings'

export const SITE_SETTINGS_SLUG = 'site-settings'

export class ShippingSettingsError extends Error {
  constructor() {
    super('Shipping settings are missing or invalid. Open Site settings in the admin and save them.')
    this.name = 'ShippingSettingsError'
  }
}

type GlobalReader = Pick<Payload, 'findGlobal'>

export const getShippingSettings = async (payload: GlobalReader): Promise<ShippingSettings> => {
  // overrideAccess is explicit: the global is admin-only and customers never read it.
  // depth 0: no relationships are needed.
  const doc = await payload.findGlobal({
    slug: SITE_SETTINGS_SLUG as never,
    depth: 0,
    overrideAccess: true,
  })

  const settings = parseShippingSettings(doc)

  if (!settings) throw new ShippingSettingsError()

  return settings
}