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
    // Each seller's share of the payment. The shares add up to amountKobo, so Vendly's share is zero.
    splits: Array<{ subaccountCode: string; amountKobo: number }>
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
    }

// A webhook event reduced to what Vendly needs. The payload itself is never trusted: a payment
// event only prompts Vendly to verify the reference with the provider.
export type WebhookEvent = {
    // Unique per event, used to recognise redeliveries.
    eventKey: string
    eventType: string
    reference: string | null
    isPaymentEvent: boolean
}

export type WebhookHeaders = Record<string, string | string[] | undefined>

// The provider calls Vendly makes. Each provider implements this; tests use a fake.
export interface PaymentProviderAdapter {
    readonly provider: PaymentProvider
    // Checks the webhook signature against the exact bytes received.
    verifyWebhook(rawBody: Buffer, headers: WebhookHeaders): boolean
    // Returns null when the body is not a recognisable event.
    parseWebhook(rawBody: Buffer): WebhookEvent | null
    initializePayment(input: InitializePaymentInput): Promise<{ authorizationUrl: string }>
    verifyPayment(reference: string): Promise<PaymentVerification>
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
