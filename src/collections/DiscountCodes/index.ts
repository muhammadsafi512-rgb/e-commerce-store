import type { Access, CollectionConfig } from 'payload'

import { DISCOUNT_CODES_SLUG } from '../../pricing/constants'
import { normalizeDiscountCode } from '../../utilities/normalizeDiscountCode'

/**
 * Local on purpose: this collection holds pricing rules, so it does not depend
 * on a helper whose behaviour could change elsewhere. Same rule as the template:
 * a user is an admin when `roles` includes `admin`.
 */
const isAdminUser = (user: unknown): boolean => {
  const roles = (user as { roles?: unknown } | null | undefined)?.roles
  return Array.isArray(roles) && roles.includes('admin')
}

export const discountCodesAdminOnly: Access = ({ req }) => isAdminUser(req.user)

const isWholeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

/** `value` means a percent (1-99) or cents, depending on `type`. */
export const validateDiscountValue = (
  value: number | null | undefined,
  { siblingData }: { siblingData?: unknown },
): true | string => {
  if (value === null || value === undefined) return 'Value is required.'

  const type = (siblingData as { type?: unknown } | undefined)?.type

  if (type === 'percent') {
    if (!isWholeNumber(value) || value < 1 || value > 99) {
      return 'A percent discount must be a whole number from 1 to 99. 100% codes are not allowed.'
    }
    return true
  }

  if (!isWholeNumber(value) || value < 1) {
    return 'A fixed discount is a whole number of cents, at least 1 (for example 500 for $5.00).'
  }
  return true
}

export const validateMaxRedemptions = (value: number | null | undefined): true | string => {
  if (value === null || value === undefined) return true
  return isWholeNumber(value) && value >= 1 ? true : 'Must be a whole number of at least 1.'
}

export const DiscountCodes: CollectionConfig = {
  slug: DISCOUNT_CODES_SLUG,
  labels: { plural: 'Discount codes', singular: 'Discount code' },
  admin: {
    defaultColumns: ['code', 'type', 'value', 'active', 'expiresAt', 'redemptions'],
    description:
      'Codes are checked on the server at checkout. Percent codes are 1-99. Fixed codes are in cents.',
    useAsTitle: 'code',
  },
  // Pricing rules: admin only for every operation. Checkout reads this
  // collection with the Local API on the server, so customers never need access.
  access: {
    create: discountCodesAdminOnly,
    delete: discountCodesAdminOnly,
    read: discountCodesAdminOnly,
    update: discountCodesAdminOnly,
  },
  fields: [
    {
      name: 'code',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      minLength: 3,
      maxLength: 32,
      admin: { description: 'Saved in uppercase. Customers can type it in any case.' },
      hooks: { beforeValidate: [({ value }) => normalizeDiscountCode(value)] },
    },
    {
      name: 'type',
      type: 'select',
      required: true,
      defaultValue: 'percent',
      options: [
        { label: 'Percent off', value: 'percent' },
        { label: 'Fixed amount off (cents)', value: 'fixed' },
      ],
    },
    {
      name: 'value',
      type: 'number',
      required: true,
      validate: validateDiscountValue,
      admin: { description: 'Percent: 1 to 99. Fixed: cents, for example 500 for $5.00.' },
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      admin: { position: 'sidebar' },
    },
    {
      name: 'expiresAt',
      type: 'date',
      admin: {
        date: { pickerAppearance: 'dayAndTime' },
        description: 'Optional. The code stops working at this moment.',
        position: 'sidebar',
      },
    },
    {
      name: 'maxRedemptions',
      type: 'number',
      validate: validateMaxRedemptions,
      admin: {
        description: 'Optional. Leave empty for unlimited. Counted when an order is paid.',
        position: 'sidebar',
      },
    },
    {
      name: 'redemptions',
      type: 'number',
      defaultValue: 0,
      // Only the server changes this (an atomic increment when an order is paid).
      // Nobody edits it through the admin or the API.
      access: { update: () => false },
      admin: { position: 'sidebar', readOnly: true },
    },
  ],
}