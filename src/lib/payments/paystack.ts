import { createHmac, timingSafeEqual } from "node:crypto"
import { readDataString, sendProviderRequest } from "./providerRequest.js"
import { PaymentProviderError, type PaymentProviderAdapter } from "./types.js"

const baseUrl = "https://api.paystack.co"

function paystackRequest(path: string, options: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {}) {
    return sendProviderRequest({
        providerName: "Paystack",
        secretKeyVariable: "PAYSTACK_SECRET_KEY",
        url: `${baseUrl}${path}`,
        ...options,
        isSuccess: (body) => (body as { status?: unknown }).status === true
    })
}

const successStatuses = new Set(["success"])
const failedStatuses = new Set(["failed", "reversed"])

export const paystackAdapter: PaymentProviderAdapter = {
    provider: "PAYSTACK",

    // Paystack signs the raw body with HMAC-SHA512 using the secret key (x-paystack-signature).
    verifyWebhook(rawBody, headers) {
        const secretKey = process.env.PAYSTACK_SECRET_KEY?.trim()
        const signature = headers["x-paystack-signature"]

        if (!secretKey || typeof signature !== "string" || !/^[0-9a-f]{128}$/i.test(signature)) {
            return false
        }

        const expected = createHmac("sha512", secretKey).update(rawBody).digest()
        return timingSafeEqual(expected, Buffer.from(signature, "hex"))
    },

    parseWebhook(rawBody) {
        let body: { event?: unknown; data?: { id?: unknown; reference?: unknown } }

        try {
            body = JSON.parse(rawBody.toString("utf8"))
        } catch {
            return null
        }

        if (typeof body?.event !== "string" || body.data?.id === undefined || body.data.id === null) {
            return null
        }

        return {
            eventKey: `${body.event}:${String(body.data.id)}`,
            eventType: body.event,
            reference: typeof body.data.reference === "string" ? body.data.reference : null,
            // Paystack only sends webhooks for successful charges, not failures.
            isPaymentEvent: body.event === "charge.success"
        }
    },

    async initializePayment(input) {
        // A flat split with the sellers' shares adding up to the total leaves Vendly ₦0, and
        // all-proportional makes each seller bear the fee on their own share (confirmed in test mode).
        const body = await paystackRequest("/transaction/initialize", {
            method: "POST",
            body: {
                email: input.email,
                amount: input.amountKobo,
                currency: "NGN",
                reference: input.reference,
                callback_url: input.callbackUrl,
                split: {
                    type: "flat",
                    bearer_type: "all-proportional",
                    subaccounts: input.splits.map((split) => ({
                        subaccount: split.subaccountCode,
                        share: split.amountKobo
                    }))
                }
            }
        })
        return { authorizationUrl: readDataString(body, "authorization_url") }
    },

    async verifyPayment(reference) {
        let body: Record<string, unknown>

        try {
            body = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`)
        } catch (error) {
            // Paystack answers an unknown reference with a 4xx "Transaction reference not found".
            if (error instanceof PaymentProviderError && error.kind === "rejected") {
                return { outcome: "not_found" }
            }

            throw error
        }

        const data = body.data as Record<string, unknown> | undefined
        const providerStatus = String(data?.status ?? "")
        const amountKobo = Number(data?.amount)

        if (!data || !providerStatus || !Number.isSafeInteger(amountKobo)) {
            throw new PaymentProviderError("unavailable", "Unexpected provider response", "Missing verification fields")
        }

        return {
            outcome: successStatuses.has(providerStatus)
                ? "success"
                : failedStatuses.has(providerStatus) ? "failed" : "pending",
            providerStatus,
            reference: String(data.reference ?? ""),
            amountKobo,
            currency: String(data.currency ?? ""),
            transactionId: data.id === undefined || data.id === null ? null : String(data.id)
        }
    },

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
        return { subaccountCode: readDataString(body, "subaccount_code"), providerAccountId: null }
    },

    async updateSubaccount({ subaccountCode }, input) {
        await paystackRequest(`/subaccount/${encodeURIComponent(subaccountCode)}`, {
            method: "PUT",
            body: {
                business_name: input.businessName,
                settlement_bank: input.bankCode,
                account_number: input.accountNumber,
                primary_contact_email: input.businessEmail,
                primary_contact_phone: input.businessPhone
            }
        })
    }
}
