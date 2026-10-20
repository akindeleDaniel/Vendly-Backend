import { timingSafeEqual } from "node:crypto"
import { readDataString, sendProviderRequest } from "./providerRequest.js"
import { PaymentProviderError, type PaymentProviderAdapter, type ProviderRefund, type SellerShare } from "./types.js"

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

// Flutterwave reports each subaccount's payout in naira inside data.meta.split_settlement_info, a JSON
// string keyed by subaccount code: { "RS_…": { subaccount_earning, merchant_commission }, … }.
// It does not report the fee separately.
function readSellerShares(data: Record<string, unknown>): SellerShare[] | null {
    const info = (data.meta as { split_settlement_info?: unknown } | null | undefined)?.split_settlement_info

    if (typeof info !== "string") {
        return null
    }

    try {
        const parsed = JSON.parse(info) as Record<string, unknown>
        const shares = Object.entries(parsed)
            .filter(([key]) => key.startsWith("RS_"))
            .map(([subaccountCode, value]) => {
                const commission = (value as { merchant_commission?: unknown })?.merchant_commission
                return {
                    subaccountCode,
                    receivedKobo: Math.round(Number((value as { subaccount_earning?: unknown })?.subaccount_earning) * 100),
                    feeKobo: null,
                    // The part of this seller's order Vendly kept, in kobo.
                    retainedKobo: commission === undefined || commission === null ? null : Math.round(Number(commission) * 100)
                }
            })
        return shares.length > 0 && shares.every((share) => Number.isSafeInteger(share.receivedKobo)) ? shares : null
    } catch {
        return null
    }
}

// What Flutterwave reports Vendly itself kept from the split (its commission), in kobo.
function readVendlyShareKobo(shares: SellerShare[] | null): number | null {
    if (!shares || shares.some((share) => share.retainedKobo === undefined || share.retainedKobo === null)) {
        return null
    }

    return shares.reduce((sum, share) => sum + (share.retainedKobo ?? 0), 0)
}

// A Flutterwave refund. Its status is "completed" (or a variant such as "completed-mpgs") when done.
function toProviderRefund(data: Record<string, unknown>): ProviderRefund {
    const providerStatus = String(data.status ?? "")
    const amount = Number(data.amount_refunded ?? data.AmountRefunded)

    if ((typeof data.id !== "number" && typeof data.id !== "string") || !providerStatus || !Number.isFinite(amount)) {
        throw new PaymentProviderError("unavailable", "Unexpected provider response", "Missing refund fields")
    }

    const createdAt = typeof data.created_at === "string" ? new Date(data.created_at) : null

    return {
        providerRefundId: String(data.id),
        outcome: providerStatus.startsWith("completed") ? "succeeded" : providerStatus === "failed" ? "failed" : "processing",
        providerStatus,
        amountKobo: Math.round(amount * 100),
        awaitingFunds: false,
        expectedAt: null,
        createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null
    }
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
            isPaymentEvent: body.event === "charge.completed",
            isRefundEvent: false
        }
    },

    async initializePayment(input) {
        // A ratio split of what each seller receives, with a flat commission for the part Vendly keeps
        // (0 normally), takes Flutterwave's fee off the settled amount before splitting, so the sellers
        // bear it and Vendly's commission arrives in full (confirmed in test mode). The ratios are
        // reduced to their smallest whole numbers.
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
                    transaction_charge: split.retainedKobo / 100
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

        const sellerShares = readSellerShares(data)

        return {
            outcome: successStatuses.has(providerStatus)
                ? "success"
                : failedStatuses.has(providerStatus) ? "failed" : "pending",
            providerStatus,
            reference: String(data.tx_ref ?? ""),
            amountKobo: Math.round(amount * 100),
            currency: String(data.currency ?? ""),
            transactionId: data.id === undefined || data.id === null ? null : String(data.id),
            sellerShares,
            vendlyShareKobo: readVendlyShareKobo(sellerShares)
        }
    },

    // Written to Flutterwave's documentation: its test mode answers every refund with an internal
    // "Service error", so refunds could not be exercised end to end. Confirm in live mode.
    async createRefund(input) {
        if (!input.transactionId) {
            throw new PaymentProviderError("unavailable", "Flutterwave transaction ID is missing", "No providerTransactionId saved")
        }

        const body = await flutterwaveRequest(`/transactions/${encodeURIComponent(input.transactionId)}/refund`, {
            method: "POST",
            body: { amount: input.amountKobo / 100, comments: input.customerNote ?? input.merchantNote }
        })
        return toProviderRefund((body.data ?? {}) as Record<string, unknown>)
    },

    async findRefunds({ transactionId, providerRefundId }) {
        if (providerRefundId) {
            const body = await flutterwaveRequest(`/refunds/${encodeURIComponent(providerRefundId)}`)
            return [toProviderRefund((body.data ?? {}) as Record<string, unknown>)]
        }

        if (!transactionId) {
            throw new PaymentProviderError("unavailable", "Flutterwave transaction ID is missing", "No providerTransactionId saved")
        }

        const body = await flutterwaveRequest(`/transactions/${encodeURIComponent(transactionId)}/refunds`)
        const refunds = Array.isArray(body.data) ? body.data as Array<Record<string, unknown>> : []
        return refunds.map((refund) => toProviderRefund(refund))
    },

    async getBalanceKobo() {
        const body = await flutterwaveRequest("/balances/NGN")
        const available = Number((body.data as { available_balance?: unknown } | null | undefined)?.available_balance)
        return Number.isFinite(available) ? Math.round(available * 100) : null
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
