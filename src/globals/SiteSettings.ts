import type { Access, GlobalConfig } from 'payload'

import {
  DEFAULT_FLAT_SHIPPING_CENTS,
  DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS,
  isWholeCents,
  MAX_SHIPPING_SETTINGS_CENTS,
} from '@/pricing/shippingSettings'

/** Same rule as the template and the discount-codes collection: `roles` includes `admin`. */
const isAdminUser: Access = ({ req }) => {
  const roles = (req.user as null | { roles?: unknown })?.roles
  return Array.isArray(roles) && roles.includes('admin')
}

export const SiteSettings: GlobalConfig = {
  slug: 'site-settings',
  label: 'Site settings',
  // Only admins read or change it. Checkout reads it on the server with the Local API.
  access: {
    read: isAdminUser,
    update: isAdminUser,
  },
  fields: [
    {
      name: 'storeName',
      type: 'text',
      label: 'Store name',
    },
    {
      name: 'flatShippingCents',
      type: 'number',
      label: 'Flat shipping (cents)',
      required: true,
      defaultValue: DEFAULT_FLAT_SHIPPING_CENTS,
      min: 0,
      admin: {
        description: 'In cents. 599 = $5.99. Use 0 for free shipping on every order.',
        step: 1,
      },
      validate: (value: null | number | undefined) =>
        isWholeCents(value, 0) ||
        `Enter whole cents from 0 to ${MAX_SHIPPING_SETTINGS_CENTS} (for example 599 for $5.99).`,
    },
    {
      name: 'freeShippingThresholdCents',
      type: 'number',
      label: 'Free shipping from (cents)',
      required: true,
      defaultValue: DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS,
      min: 1,
      admin: {
        description:
          'In cents. 7500 = $75.00. Compared with the subtotal AFTER any discount code. Orders at or above it ship free.',
        step: 1,
      },
      validate: (value: null | number | undefined) =>
        isWholeCents(value, 1) ||
        `Enter whole cents from 1 to ${MAX_SHIPPING_SETTINGS_CENTS} (for example 7500 for $75.00).`,
    },
  ],
}