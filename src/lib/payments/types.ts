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

// The provider calls Vendly makes. Each provider implements this; tests use a fake.
// Payment initialization, verification and webhooks join this interface in later phases.
export interface PaymentProviderAdapter {
    readonly provider: PaymentProvider
    resolveAccount(input: ResolveAccountInput): Promise<{ accountName: string }>
    createSubaccount(input: CreateSubaccountInput): Promise<{ subaccountCode: string }>
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
