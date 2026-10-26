import type { PaymentProvider } from "../../generated/prisma/client.js"

export type ResolveAccountInput = {
    bankCode: string
    accountNumber: string
}

export type CreateSubaccountInput = {
    businessName: string
    businessEmail: string
    businessPhone: string
    bankCode: string
    accountNumber: string
}

// Amounts are whole kobo; each adapter converts to the unit its provider expects.
export type InitializePaymentInput = {
    reference: string
    amountKobo: number
    email: string
    callbackUrl: string
    // One entry per seller order. amountKobo is what the seller receives; retainedKobo is the part of
    // their order StoreHatch keeps to recover what they owe for earlier refunds (usually 0). The two add up
    // to the seller order's total, and the retained parts together make up StoreHatch's own share.
    splits: Array<{ subaccountCode: string; amountKobo: number; retainedKobo: number }>
}

// One seller's part of a split payment as the provider reported it. feeKobo is null when the provider
// reports only the payout, in which case the fee is the seller's order total minus the payout.
export type SellerShare = {
    subaccountCode: string
    receivedKobo: number
    feeKobo: number | null
    // The part of this seller's order StoreHatch kept, when the provider reports it per seller (Flutterwave).
    retainedKobo?: number | null
}

// "success" and "failed" are final. "pending" means the customer may still pay.
// "not_found" means the provider has no transaction with this reference.
export type PaymentVerification =
    | { outcome: "not_found" }
    | {
        outcome: "success" | "failed" | "pending"
        providerStatus: string
        reference: string
        amountKobo: number
        currency: string
        transactionId: string | null
        // Null when the provider did not report the split.
        sellerShares?: SellerShare[] | null
        // What the provider reports StoreHatch itself received from the split, in kobo (null if not reported).
        vendlyShareKobo?: number | null
    }

export type CreateRefundInput = {
    // StoreHatch's own reference for the payment, plus the provider's transaction ID when it has one.
    transactionReference: string
    transactionId: string | null
    amountKobo: number
    customerNote: string | null
    merchantNote: string
}

// A refund as the provider reports it. "succeeded" and "failed" are final.
export type ProviderRefund = {
    providerRefundId: string
    outcome: "processing" | "succeeded" | "failed" | "needs_attention"
    providerStatus: string
    amountKobo: number
    // True while the provider is waiting for StoreHatch's balance to cover the refund.
    awaitingFunds: boolean
    expectedAt: Date | null
    createdAt: Date | null
}

// A webhook event reduced to what StoreHatch needs. The payload itself is never trusted: a payment
// event only prompts StoreHatch to verify the reference with the provider.
export type WebhookEvent = {
    // Unique per event, used to recognise redeliveries.
    eventKey: string
    eventType: string
    reference: string | null
    isPaymentEvent: boolean
    // A refund status change. Like payment events, it only prompts StoreHatch to ask the provider.
    isRefundEvent: boolean
}

export type WebhookHeaders = Record<string, string | string[] | undefined>

// The provider calls StoreHatch makes. Each provider implements this; tests use a fake.
export interface PaymentProviderAdapter {
    readonly provider: PaymentProvider
    // Checks the webhook signature against the exact bytes received.
    verifyWebhook(rawBody: Buffer, headers: WebhookHeaders): boolean
    // Returns null when the body is not a recognisable event.
    parseWebhook(rawBody: Buffer): WebhookEvent | null
    initializePayment(input: InitializePaymentInput): Promise<{ authorizationUrl: string }>
    verifyPayment(reference: string): Promise<PaymentVerification>
    createRefund(input: CreateRefundInput): Promise<ProviderRefund>
    // The provider's refunds for one payment. When providerRefundId is known, that refund is looked up
    // directly where the provider allows it.
    findRefunds(input: { transactionReference: string; transactionId: string | null; providerRefundId: string | null }): Promise<ProviderRefund[]>
    // StoreHatch's available balance at the provider, in kobo, or null when the provider does not say.
    getBalanceKobo(): Promise<number | null>
    resolveAccount(input: ResolveAccountInput): Promise<{ accountName: string }>
    createSubaccount(input: CreateSubaccountInput): Promise<ProviderSubaccount>
    // Points an existing subaccount at different bank details. The subaccount code stays the same.
    updateSubaccount(subaccount: ProviderSubaccount, input: CreateSubaccountInput): Promise<void>
}

// subaccountCode is what payment splits use. providerAccountId is the provider's own record ID,
// when updates need it (Flutterwave).
export type ProviderSubaccount = {
    subaccountCode: string
    providerAccountId: string | null
}

// "rejected": the provider refused the request (for example invalid account details).
// "unavailable": the provider could not be reached, timed out, failed or is not configured.
// providerMessage is for server logs only and is never sent to clients.
export class PaymentProviderError extends Error {
    constructor(
        readonly kind: "rejected" | "unavailable",
        message: string,
        readonly providerMessage?: string
    ) {
        super(message)
    }
}
