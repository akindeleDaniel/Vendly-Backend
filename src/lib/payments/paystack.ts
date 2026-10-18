import { readDataString, sendProviderRequest } from "./providerRequest.js"
import type { PaymentProviderAdapter } from "./types.js"

const baseUrl = "https://api.paystack.co"

function paystackRequest(path: string, options: { method?: "GET" | "POST"; body?: unknown } = {}) {
    return sendProviderRequest({
        providerName: "Paystack",
        secretKeyVariable: "PAYSTACK_SECRET_KEY",
        url: `${baseUrl}${path}`,
        ...options,
        isSuccess: (body) => (body as { status?: unknown }).status === true
    })
}

export const paystackAdapter: PaymentProviderAdapter = {
    provider: "PAYSTACK",

    async resolveAccount({ bankCode, accountNumber }) {
        const query = new URLSearchParams({ account_number: accountNumber, bank_code: bankCode })
        const body = await paystackRequest(`/bank/resolve?${query}`)
        return { accountName: readDataString(body, "account_name") }
    },

    async createSubaccount(input) {
        // percentage_charge is Vendly's cut. Vendly takes no commission, and each payment's
        // split sets the sellers' shares explicitly.
        const body = await paystackRequest("/subaccount", {
            method: "POST",
            body: {
                business_name: input.businessName,
                settlement_bank: input.bankCode,
                account_number: input.accountNumber,
                percentage_charge: 0,
                primary_contact_email: input.businessEmail,
                primary_contact_phone: input.businessPhone
            }
        })
        return { subaccountCode: readDataString(body, "subaccount_code") }
    }
}
