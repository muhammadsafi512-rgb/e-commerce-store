import { formBuilderPlugin } from '@payloadcms/plugin-form-builder'
import { seoPlugin } from '@payloadcms/plugin-seo'
import { Plugin } from 'payload'
import { GenerateTitle, GenerateURL } from '@payloadcms/plugin-seo/types'
import { FixedToolbarFeature, HeadingFeature, lexicalEditor } from '@payloadcms/richtext-lexical'
import { ecommercePlugin } from '@payloadcms/plugin-ecommerce'

import { stripeAdapter } from '@payloadcms/plugin-ecommerce/payments/stripe'

import { Page, Product } from '@/payload-types'
import { getServerSideURL } from '@/utilities/getURL'
import { ProductsCollection } from '@/collections/Products'
import { VariantsCollection } from '@/collections/Variants'
import { adminOrPublishedStatus } from '@/access/adminOrPublishedStatus'
import { adminOnlyFieldAccess } from '@/access/adminOnlyFieldAccess'
import { customerOnlyFieldAccess } from '@/access/customerOnlyFieldAccess'
import { isAdmin } from '@/access/isAdmin'
import { isDocumentOwner } from '@/access/isDocumentOwner'
import { nobody } from '@/access/nobody'
import { addSnapshotFields } from '@/collections/Orders/snapshotFields'
import { snapshotOrderItems } from '@/collections/Orders/snapshotOrderItems'
import { attentionFields } from '@/collections/Orders/attentionFields'
import { copyPricingToOrder } from '@/collections/Orders/copyPricingToOrder'
import { orderPricingFields } from '@/collections/Orders/pricingFields'
import { TransactionsCollection } from '@/collections/Transactions'
import { stripeWebhooks } from '@/payments/stripeWebhooks'
import { withCheckoutValidation } from '@/payments/withCheckoutValidation'

const generateTitle: GenerateTitle<Product | Page> = ({ doc }) => {
  return doc?.title ? `${doc.title} | Payload Ecommerce Template` : 'Payload Ecommerce Template'
}

const generateURL: GenerateURL<Product | Page> = ({ doc }) => {
  const url = getServerSideURL()

  return doc?.slug ? `${url}/${doc.slug}` : url
}

export const plugins: Plugin[] = [
  seoPlugin({
    generateTitle,
    generateURL,
  }),
  formBuilderPlugin({
    fields: {
      payment: false,
    },
    formSubmissionOverrides: {
      access: {
        delete: isAdmin,
        read: isAdmin,
        update: isAdmin,
      },
      admin: {
        group: 'Content',
      },
    },
    formOverrides: {
      access: {
        delete: isAdmin,
        read: isAdmin,
        update: isAdmin,
        create: isAdmin,
      },
      admin: {
        group: 'Content',
      },
      fields: ({ defaultFields }) => {
        return defaultFields.map((field) => {
          if ('name' in field && field.name === 'confirmationMessage') {
            return {
              ...field,
              editor: lexicalEditor({
                features: ({ rootFeatures }) => {
                  return [
                    ...rootFeatures,
                    FixedToolbarFeature(),
                    HeadingFeature({ enabledHeadingSizes: ['h1', 'h2', 'h3', 'h4'] }),
                  ]
                },
              }),
            }
          }
          return field
        })
      },
    },
  }),
  ecommercePlugin({
    access: {
      adminOnlyFieldAccess,
      adminOrPublishedStatus,
      customerOnlyFieldAccess,
      isAdmin,
      isDocumentOwner,
    },
    customers: {
      slug: 'users',
    },
    orders: {
      ordersCollectionOverride: ({ defaultCollection }) => ({
        ...defaultCollection,
        access: {
          ...defaultCollection.access,
          // Orders are financial records: never deletable via admin/REST/GraphQL.
          // Local API calls (seed, server code) still bypass access by default.
          delete: nobody,
        },
        hooks: {
          ...defaultCollection.hooks,
          // Fills title/sku/unit price on each order line at creation. Never throws.
          // Then copies the price breakdown from the transaction (decision #40). Never throws.
          beforeChange: [
            ...(defaultCollection.hooks?.beforeChange ?? []),
            snapshotOrderItems,
            copyPricingToOrder,
          ],
        },
        admin: {
          ...defaultCollection.admin,
          // Show the oversold / needs-attention flag in the orders list.
          defaultColumns: Array.from(
            new Set([...(defaultCollection.admin?.defaultColumns ?? []), 'needsAttention']),
          ),
        },
        fields: [
          ...addSnapshotFields(defaultCollection.fields),
          ...attentionFields,
          ...orderPricingFields,
          {
            name: 'accessToken',
            type: 'text',
            unique: true,
            index: true,
            admin: {
              position: 'sidebar',
              readOnly: true,
            },
            hooks: {
              beforeValidate: [
                ({ value, operation }) => {
                  if (operation === 'create' || !value) {
                    return crypto.randomUUID()
                  }
                  return value
                },
              ],
            },
          },
        ],
      }),
    },
    payments: {
      paymentMethods: [
        // Validates stock, price and variants before a PaymentIntent is created (decisions #21, #22).
        withCheckoutValidation(
          stripeAdapter({
            secretKey: process.env.STRIPE_SECRET_KEY!,
            publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
            webhookSecret: process.env.STRIPE_WEBHOOKS_SIGNING_SECRET!,
            // Creates the order when a customer pays but never reaches the confirm step (decision #37).
            webhooks: stripeWebhooks,
          }),
        ),
      ],
    },
    transactions: {
      // Adds the price breakdown fields and hook (#39), the oversold-order flag (#35) and the
      // discount redemption counter (#40). 'items' is not changed.
      transactionsCollectionOverride: TransactionsCollection,
    },
    products: {
      productsCollectionOverride: ProductsCollection,
      variants: {
        variantsCollectionOverride: VariantsCollection,
      },
    },
  }),
]