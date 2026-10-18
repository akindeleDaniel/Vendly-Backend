import type { PaymentProvider } from "../../generated/prisma/client.js"
import { flutterwaveAdapter } from "./flutterwave.js"
import { paystackAdapter } from "./paystack.js"
import type { PaymentProviderAdapter } from "./types.js"

export const paymentProviders: readonly PaymentProvider[] = ["PAYSTACK", "FLUTTERWAVE"]

export const paymentProviderNames: Record<PaymentProvider, string> = {
    PAYSTACK: "Paystack",
    FLUTTERWAVE: "Flutterwave"
}

const defaultAdapters: Record<PaymentProvider, PaymentProviderAdapter> = {
    PAYSTACK: paystackAdapter,
    FLUTTERWAVE: flutterwaveAdapter
}

let activeAdapters = defaultAdapters

export function getPaymentProvider(provider: PaymentProvider): PaymentProviderAdapter {
    return activeAdapters[provider]
}

// Lets automated tests swap in fake providers so they never call Paystack or Flutterwave.
// Pass null to restore the real adapters.
export function setPaymentProvidersForTesting(adapters: Record<PaymentProvider, PaymentProviderAdapter> | null): void {
    activeAdapters = adapters ?? defaultAdapters
}
