import { readDataString, sendProviderRequest } from "./providerRequest.js"
import type { PaymentProviderAdapter } from "./types.js"

// Flutterwave API v3: v4 does not support hosted payment pages, split payments or subaccounts.
const baseUrl = "https://api.flutterwave.com/v3"

function flutterwaveRequest(path: string, options: { method?: "GET" | "POST"; body?: unknown } = {}) {
    return sendProviderRequest({
        providerName: "Flutterwave",
        secretKeyVariable: "FLUTTERWAVE_SECRET_KEY",
        url: `${baseUrl}${path}`,
        ...options,
        isSuccess: (body) => (body as { status?: unknown }).status === "success"
    })
}

export const flutterwaveAdapter: PaymentProviderAdapter = {
    provider: "FLUTTERWAVE",

    async resolveAccount({ bankCode, accountNumber }) {
        const body = await flutterwaveRequest("/accounts/resolve", {
            method: "POST",
            body: { account_number: accountNumber, account_bank: bankCode }
        })
        return { accountName: readDataString(body, "account_name") }
    },

    async createSubaccount(input) {
        // split_value is Vendly's commission, which is zero.
        const body = await flutterwaveRequest("/subaccounts", {
            method: "POST",
            body: {
                account_bank: input.bankCode,
                account_number: input.accountNumber,
                business_name: input.businessName,
                business_email: input.businessEmail,
                business_mobile: input.businessPhone,
                country: "NG",
                split_type: "percentage",
                split_value: 0
            }
        })
        return { subaccountCode: readDataString(body, "subaccount_id") }
    }
}
