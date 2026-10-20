import { createHmac, timingSafeEqual } from "node:crypto"
import { readDataString, sendProviderRequest } from "./providerRequest.js"
import { PaymentProviderError, type PaymentProviderAdapter, type ProviderRefund, type SellerShare } from "./types.js"

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

// Paystack reports each subaccount's payout and fee, in kobo, under data.split.shares.subaccounts.
function readSellerShares(data: Record<string, unknown>): SellerShare[] | null {
    const subaccounts = (data.split as { shares?: { subaccounts?: unknown } } | null | undefined)?.shares?.subaccounts

    if (!Array.isArray(subaccounts)) {
        return null
    }

    const shares = subaccounts.map((share: { subaccount_code?: unknown; amount?: unknown; fees?: unknown }) => ({
        subaccountCode: typeof share?.subaccount_code === "string" ? share.subaccount_code : "",
        receivedKobo: Number(share?.amount),
        feeKobo: Number(share?.fees)
    }))

    return shares.every((share) => share.subaccountCode && Number.isSafeInteger(share.receivedKobo) && Number.isSafeInteger(share.feeKobo))
        ? shares
        : null
}

// Paystack reports Vendly's own share, after its part of the fee, as split.shares.integration (kobo).
function readVendlyShareKobo(data: Record<string, unknown>): number | null {
    const share = Number((data.split as { shares?: { integration?: unknown } } | null | undefined)?.shares?.integration)
    return Number.isSafeInteger(share) ? share : null
}

// A Paystack refund. fully_deducted says whether Vendly's balance has covered it; only the list and
// fetch responses report that reliably, so the create response never claims the refund awaits funds.
function toProviderRefund(data: Record<string, unknown>, reportsFunding: boolean): ProviderRefund {
    const providerStatus = String(data.status ?? "")
    const amountKobo = Number(data.amount)

    if ((typeof data.id !== "number" && typeof data.id !== "string") || !providerStatus || !Number.isSafeInteger(amountKobo)) {
        throw new PaymentProviderError("unavailable", "Unexpected provider response", "Missing refund fields")
    }

    const outcome = providerStatus === "processed"
        ? "succeeded"
        : providerStatus === "failed"
            ? "failed"
            : providerStatus === "needs-attention" ? "needs_attention" : "processing"
    const expectedAt = typeof data.expected_at === "string" ? new Date(data.expected_at) : null
    const createdAt = typeof data.createdAt === "string" ? new Date(data.createdAt) : null

    return {
        providerRefundId: String(data.id),
        outcome,
        providerStatus,
        amountKobo,
        awaitingFunds: reportsFunding && outcome === "processing" && !data.fully_deducted,
        expectedAt: expectedAt && !Number.isNaN(expectedAt.getTime()) ? expectedAt : null,
        createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null
    }
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
        let body: { event?: unknown; data?: { id?: unknown; reference?: unknown; transaction_reference?: unknown } }

        try {
            body = JSON.parse(rawBody.toString("utf8"))
        } catch {
            return null
        }

        if (typeof body?.event !== "string") {
            return null
        }

        // Refund events (refund.pending, refund.processed and so on) carry the payment's reference
        // but no ID of their own. Refunds are re-checked with Paystack, so redelivery is harmless.
        if (body.event.startsWith("refund.")) {
            const reference = typeof body.data?.transaction_reference === "string" ? body.data.transaction_reference : null
            return {
                eventKey: `${body.event}:${reference ?? "unknown"}`,
                eventType: body.event,
                reference,
                isPaymentEvent: false,
                isRefundEvent: true
            }
        }

        if (body.data?.id === undefined || body.data.id === null) {
            return null
        }

        return {
            eventKey: `${body.event}:${String(body.data.id)}`,
            eventType: body.event,
            reference: typeof body.data.reference === "string" ? body.data.reference : null,
            // Paystack only sends webhooks for successful charges, not failures.
            isPaymentEvent: body.event === "charge.success",
            isRefundEvent: false
        }
    },

    async initializePayment(input) {
        // A flat split gives each seller their share and sends whatever is left to Vendly: ₦0 normally,
        // or the amount kept to recover a seller's earlier refund. All-proportional makes every party,
        // Vendly included, bear the fee in proportion to its share (confirmed in test mode).
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
            transactionId: data.id === undefined || data.id === null ? null : String(data.id),
            sellerShares: readSellerShares(data),
            vendlyShareKobo: readVendlyShareKobo(data)
        }
    },

    async createRefund(input) {
        const body = await paystackRequest("/refund", {
            method: "POST",
            body: {
                transaction: input.transactionReference,
                amount: input.amountKobo,
                currency: "NGN",
                ...(input.customerNote ? { customer_note: input.customerNote } : {}),
                merchant_note: input.merchantNote
            }
        })
        return toProviderRefund((body.data ?? {}) as Record<string, unknown>, false)
    },

    async findRefunds({ transactionId }) {
        if (!transactionId) {
            throw new PaymentProviderError("unavailable", "Paystack transaction ID is missing", "No providerTransactionId saved")
        }

        const query = new URLSearchParams({ transaction: transactionId, perPage: "100" })
        const body = await paystackRequest(`/refund?${query}`)
        const refunds = Array.isArray(body.data) ? body.data as Array<Record<string, unknown>> : []
        return refunds.map((refund) => toProviderRefund(refund, true))
    },

    async getBalanceKobo() {
        const body = await paystackRequest("/balance")
        const balances = Array.isArray(body.data) ? body.data as Array<{ currency?: unknown; balance?: unknown }> : []
        const naira = balances.find((balance) => balance.currency === "NGN")
        const kobo = Number(naira?.balance)
        return Number.isSafeInteger(kobo) ? kobo : null
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
