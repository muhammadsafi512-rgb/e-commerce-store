import { cartItemsMatch, getRelationshitID, normalizeEmail } from "./normalize";

type RecordValue = Record<string, unknown>

const isRecord = (value: unknown): value is RecordValue => 
    typeof value === 'object' && value !== null && !Array.isArray(value)

type PaymentIntentLike = {
    amount?: unknown
    currency?: unknown
    customer?: unknown
    id?: unknown
    metadata?: unknown
    status?: unknown
}

const nested = (value: unknown, group: string, field: string): string | undefined => {
    if (!isRecord(value)) return undefined
    const inner = value[group]

    return isRecord(inner) && typeof inner[field] === 'string' ? (inner[field] as string ): undefined
}

/**
 * Checks a succeeded Stripe PaymentIntent against our transaction before the webhook creates
 * an order. Same checks as the plugin's `validateSettlement`, minus the parts that only make
 * sense with a logged-in browser request (the webhook has no user and no submitted email; the
 * purchaser comes from the transaction, which our server wrote when the payment was started).
 * Throws on any mismatch.
 */

export const validateWebhookSettlement = ({
    cartItemsSnapshot,
    paymentIntent,
    transaction,
}: {
    cartItemsSnapshot: unknown
    paymentIntent: PaymentIntentLike
    transaction: RecordValue
}) : void => {
    const paymentIntentID = nested(transaction, 'stripe','paymentIntentID')

    if(!paymentIntentID || paymentIntentID !== paymentIntent.id) {
        throw new Error('PaymentIntent does not match the transaction')
    }

    const cartID = getRelationshitID(transaction.cart)
    const metadata = isRecord(paymentIntent.metadata) ? paymentIntent.metadata : undefined

    if (!cartID || cartID !== getRelationshitID(metadata?.cartID)) {
        throw new Error('Transaction cart does not match the PaymentIntent cart')
    }

    if(!getRelationshitID(transaction.customer) && !normalizeEmail(transaction.customerEmail)) {
        throw new Error('Transaction has neither a customer nor a customer email')
    }

    const stripeCustomerID = nested(transaction, 'stripe', 'customerID')

    if (!stripeCustomerID || stripeCustomerID !== getRelationshitID(paymentIntent.customer)) {
        throw new Error('Stripe customer does not match the transaction')
    }

    if (typeof paymentIntent.amount !== 'number' || paymentIntent.amount !== transaction.amount) {
        throw new Error('Stripe amount does not match the transaction amount')
    }

    if(
        typeof paymentIntent.currency !== 'string' || typeof transaction.currency !== 'string' ||
        paymentIntent.currency.toUpperCase() !== transaction.currency
    ) {
        throw new Error('Stripe currency does not match the transaction currency')
    }

    if (!cartItemsMatch(cartItemsSnapshot, transaction.items)) {
        throw new Error('Stripe cart items do not match with the trnsaction items')
    }

    if (paymentIntent.status !== 'succeeded') {
        throw new Error('Payment not completed.')
    }
}   