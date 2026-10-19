import { timingSafeEqual } from "node:crypto"
import { readDataString, sendProviderRequest } from "./providerRequest.js"
import { PaymentProviderError, type PaymentProviderAdapter } from "./types.js"

function readDataId(body: Record<string, unknown>): string {
    const id = (body.data as { id?: unknown } | undefined)?.id

    if (typeof id !== "number" && typeof id !== "string") {
        throw new PaymentProviderError("unavailable", "Unexpected provider response", "Missing data.id")
    }

    return String(id)
}

// Flutterwave API v3: v4 does not support hosted payment pages, split payments or subaccounts.
const baseUrl = "https://api.flutterwave.com/v3"

function flutterwaveRequest(path: string, options: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {}) {
    return sendProviderRequest({
        providerName: "Flutterwave",
        secretKeyVariable: "FLUTTERWAVE_SECRET_KEY",
        url: `${baseUrl}${path}`,
        ...options,
        isSuccess: (body) => (body as { status?: unknown }).status === "success"
    })
}

function greatestCommonDivisor(a: number, b: number): number {
    return b === 0 ? a : greatestCommonDivisor(b, a % b)
}

const successStatuses = new Set(["successful"])
const failedStatuses = new Set(["failed", "cancelled"])

export const flutterwaveAdapter: PaymentProviderAdapter = {
    provider: "FLUTTERWAVE",

    // Flutterwave sends the secret hash set in its dashboard in the verif-hash header.
    verifyWebhook(_rawBody, headers) {
        const secret = process.env.FLUTTERWAVE_WEBHOOK_SECRET?.trim()
        const received = headers["verif-hash"]

        if (!secret || typeof received !== "string") {
            return false
        }

        const expected = Buffer.from(secret)
        const actual = Buffer.from(received)
        return expected.length === actual.length && timingSafeEqual(expected, actual)
    },

    parseWebhook(rawBody) {
        let body: { event?: unknown; data?: { id?: unknown; tx_ref?: unknown } }

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
            reference: typeof body.data.tx_ref === "string" ? body.data.tx_ref : null,
            // Sent for both successful and failed charges.
            isPaymentEvent: body.event === "charge.completed"
        }
    },

    async initializePayment(input) {
        // A ratio split by each seller's total, with no Vendly commission, takes Flutterwave's fee off
        // the settled amount before splitting, so each seller bears it on their own share (confirmed in
        // test mode). The ratios are reduced to their smallest whole numbers.
        const divisor = input.splits.reduce((gcd, split) => greatestCommonDivisor(gcd, split.amountKobo), 0) || 1
        const body = await flutterwaveRequest("/payments", {
            method: "POST",
            body: {
                tx_ref: input.reference,
                amount: input.amountKobo / 100,
                currency: "NGN",
                redirect_url: input.callbackUrl,
                customer: { email: input.email },
                subaccounts: input.splits.map((split) => ({
                    id: split.subaccountCode,
                    transaction_split_ratio: split.amountKobo / divisor,
                    transaction_charge_type: "flat",
                    transaction_charge: 0
                }))
            }
        })
        return { authorizationUrl: readDataString(body, "link") }
    },

    async verifyPayment(reference) {
        let body: Record<string, unknown>

        try {
            body = await flutterwaveRequest(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`)
        } catch (error) {
            // Flutterwave answers "No transaction was found" until the customer actually pays.
            if (error instanceof PaymentProviderError && error.kind === "rejected") {
                return { outcome: "not_found" }
            }

            throw error
        }

        const data = body.data as Record<string, unknown> | undefined
        const providerStatus = String(data?.status ?? "")
        const amount = Number(data?.amount)

        if (!data || !providerStatus || !Number.isFinite(amount)) {
            throw new PaymentProviderError("unavailable", "Unexpected provider response", "Missing verification fields")
        }

        return {
            outcome: successStatuses.has(providerStatus)
                ? "success"
                : failedStatuses.has(providerStatus) ? "failed" : "pending",
            providerStatus,
            reference: String(data.tx_ref ?? ""),
            amountKobo: Math.round(amount * 100),
            currency: String(data.currency ?? ""),
            transactionId: data.id === undefined || data.id === null ? null : String(data.id)
        }
    },

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
        return { subaccountCode: readDataString(body, "subaccount_id"), providerAccountId: readDataId(body) }
    },

    // Flutterwave updates by its numeric subaccount ID; the RS_ code is rejected here.
    async updateSubaccount({ providerAccountId }, input) {
        if (!providerAccountId) {
            throw new PaymentProviderError("unavailable", "Flutterwave subaccount ID is missing", "No providerAccountId saved")
        }

        await flutterwaveRequest(`/subaccounts/${encodeURIComponent(providerAccountId)}`, {
            method: "PUT",
            body: {
                account_bank: input.bankCode,
                account_number: input.accountNumber,
                business_name: input.businessName,
                business_email: input.businessEmail,
                split_type: "percentage",
                split_value: 0
            }
        })
    }
}
