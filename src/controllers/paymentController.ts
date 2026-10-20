import { randomBytes } from "node:crypto"
import type { Request, Response } from "express"
import config from "../config.js"
import prisma from "../lib/prisma.js"
import { Prisma, type PaymentAttempt, type PaymentProvider } from "../generated/prisma/client.js"
import { acquireCheckoutCreationLock, expireExpiredCheckouts } from "./checkoutController.js"
import { getPaymentProvider, paymentProviderNames, paymentProviders } from "../lib/payments/providers.js"
import { settleCheckoutPayment } from "../lib/payments/settlement.js"
import { PaymentProviderError, type PaymentVerification } from "../lib/payments/types.js"

// Starting a payment extends the checkout and its stock hold to this long from that moment.
const paymentWindowMs = 30 * 60 * 1000
// An attempt without a payment link younger than this may still be waiting for the provider.
const initializingGraceMs = 60 * 1000
// A payment the customer never tried to pay is closed this long after its checkout expired,
// releasing the stock. Providers never mark these failed: Paystack keeps reporting "abandoned" and
// Flutterwave keeps answering that no transaction exists.
const abandonedAfterExpiryMs = 30 * 60 * 1000
const availablePaymentProviders: readonly PaymentProvider[] = ["PAYSTACK", "FLUTTERWAVE"]

export type PaymentErrorCode =
    | "PAYMENT_PROVIDER_NOT_AVAILABLE"
    | "PAYMENT_ALREADY_COMPLETED"
    | "CHECKOUT_EXPIRED"
    | "CHECKOUT_NOT_PAYABLE"
    | "PAYMENT_IN_PROGRESS"
    | "PAYMENT_INITIALIZING"
    | "PAYMENT_SELLER_NOT_READY"
    | "PAYMENT_PROVIDER_REJECTED"
    | "PAYMENT_PROVIDER_UNAVAILABLE"
    | "PAYMENT_CONFLICT"

class PaymentRequestError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
        readonly code?: PaymentErrorCode,
        readonly details: Record<string, unknown> = {}
    ) {
        super(message)
    }
}

function toKobo(amount: Prisma.Decimal): number {
    const kobo = amount.times(100)

    if (!kobo.isInteger()) {
        throw new Error("Payment amounts must have at most two decimal places")
    }

    return kobo.toNumber()
}

function toPaymentResponse(
    attempt: PaymentAttempt,
    checkout: { id: number; status: string; expiresAt: Date }
) {
    return {
        reference: attempt.reference,
        provider: attempt.provider,
        status: attempt.status,
        amount: attempt.amount.toFixed(2),
        currency: attempt.currency,
        authorizationUrl: attempt.status === "PENDING" ? attempt.authorizationUrl : null,
        failureReason: attempt.failureReason,
        checkout: {
            id: checkout.id,
            status: checkout.status,
            expiresAt: checkout.expiresAt
        }
    }
}

function sendPaymentRequestError(error: unknown, res: Response): boolean {
    if (error instanceof PaymentRequestError) {
        res.status(error.statusCode).send({
            message: error.message,
            ...(error.code ? { code: error.code } : {}),
            ...error.details
        })
        return true
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        res.status(409).send({
            message: "The checkout changed while starting payment. Please try again.",
            code: "PAYMENT_CONFLICT"
        })
        return true
    }

    return false
}

// Records what the provider reported for a PENDING attempt. Success is accepted only when the
// reference, amount and currency all match what Vendly asked for. Every write is conditional on
// the attempt still being PENDING, so repeated or concurrent checks cannot change a final result.
// Completing the checkout and its orders (settlement) is a separate step.
async function applyVerification(attempt: PaymentAttempt, verification: PaymentVerification): Promise<void> {
    const now = new Date()
    const stillPending = { id: attempt.id, status: "PENDING" as const }

    const isPastAbandonDeadline = async () => {
        const checkout = await prisma.checkout.findUniqueOrThrow({
            where: { id: attempt.checkoutId },
            select: { expiresAt: true }
        })
        return checkout.expiresAt.getTime() <= now.getTime() - abandonedAfterExpiryMs
    }
    const closedInTime = { status: "FAILED" as const, failureReason: "The payment was not completed in time" }

    if (verification.outcome === "not_found") {
        const abandoned = attempt.authorizationUrl !== null && await isPastAbandonDeadline()
        await prisma.paymentAttempt.updateMany({
            where: stillPending,
            data: abandoned ? { lastCheckedAt: now, ...closedInTime } : { lastCheckedAt: now }
        })
        return
    }

    const observed = {
        providerStatus: verification.providerStatus,
        providerTransactionId: verification.transactionId,
        lastCheckedAt: now
    }

    if (verification.outcome === "pending") {
        const abandoned = verification.providerStatus === "abandoned" && await isPastAbandonDeadline()
        await prisma.paymentAttempt.updateMany({
            where: stillPending,
            data: abandoned ? { ...observed, ...closedInTime } : observed
        })
        return
    }

    if (verification.outcome === "failed") {
        await prisma.paymentAttempt.updateMany({
            where: stillPending,
            data: { ...observed, status: "FAILED", failureReason: "The payment was not completed" }
        })
        return
    }

    const matches = verification.reference === attempt.reference &&
        verification.currency === attempt.currency &&
        verification.amountKobo === toKobo(attempt.amount)

    if (!matches) {
        // Money may have moved, so the attempt stays PENDING (keeping its stock protected) for review.
        console.error("Payment verification mismatch", {
            reference: attempt.reference,
            expected: { amountKobo: toKobo(attempt.amount), currency: attempt.currency },
            received: {
                reference: verification.reference,
                amountKobo: verification.amountKobo,
                currency: verification.currency
            }
        })
        await prisma.paymentAttempt.updateMany({
            where: stillPending,
            data: { ...observed, failureReason: "The payment details did not match and need review" }
        })
        return
    }

    await prisma.paymentAttempt.updateMany({
        where: stillPending,
        data: {
            ...observed,
            status: "SUCCESS",
            verifiedAt: now,
            failureReason: null,
            ...(verification.sellerShares ? { sellerShares: verification.sellerShares as Prisma.InputJsonValue } : {})
        }
    })
}

// An attempt that never received a payment link (the provider timed out or failed during
// initialization) is checked with the provider before a new attempt may start. Nobody has a link
// to pay it, so anything short of a verified success closes it as failed.
async function reconcileUnstartedAttempt(attempt: PaymentAttempt): Promise<void> {
    let verification: PaymentVerification

    try {
        verification = await getPaymentProvider(attempt.provider).verifyPayment(attempt.reference)
    } catch (error) {
        console.error("Payment reconciliation failed", {
            reference: attempt.reference,
            reason: error instanceof PaymentProviderError ? error.providerMessage ?? error.message : undefined
        })
        throw new PaymentRequestError(
            502,
            `We could not reach ${paymentProviderNames[attempt.provider]}. Try again.`,
            "PAYMENT_PROVIDER_UNAVAILABLE"
        )
    }

    if (verification.outcome === "success") {
        await applyVerification(attempt, verification)
        return
    }

    await prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: "PENDING" },
        data: {
            status: "FAILED",
            failureReason: "The payment was never started",
            lastCheckedAt: new Date(),
            ...(verification.outcome !== "not_found"
                ? { providerStatus: verification.providerStatus, providerTransactionId: verification.transactionId }
                : {})
        }
    })
}

// Brings a payment up to date with its provider and settles it once verified as successful.
// Used by the status endpoint, webhooks and payment start. Throws when the provider cannot be
// reached, so callers decide whether that matters (a webhook asks to be retried; the status
// endpoint returns the saved status).
export async function syncPayment(attempt: PaymentAttempt): Promise<void> {
    if (attempt.status === "PENDING") {
        if (!attempt.authorizationUrl && attempt.createdAt.getTime() <= Date.now() - initializingGraceMs) {
            await reconcileUnstartedAttempt(attempt)
        } else {
            await applyVerification(attempt, await getPaymentProvider(attempt.provider).verifyPayment(attempt.reference))
        }
    }

    const current = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
        select: { id: true, status: true, checkout: { select: { status: true, userId: true } } }
    })

    if (current.status === "SUCCESS" && current.checkout.status !== "COMPLETED") {
        await settleCheckoutPayment(current.id)
    }

    // A payment that failed after its checkout expired no longer protects the checkout's stock.
    // The expired checkout is not reopened.
    // A conflicting write means another request is already expiring it; the next request retries.
    if (current.status === "FAILED" && attempt.status === "PENDING") {
        try {
            await expireExpiredCheckouts(current.checkout.userId)
        } catch (error) {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")) {
                throw error
            }
        }
    }
}

// Starts (or resumes) payment for one of the consumer's checkouts with the chosen provider and
// returns the provider's hosted payment page. The attempt is saved, and the checkout moved to
// PAYMENT_PENDING with a 30-minute hold, before the provider is called outside the transaction.
export async function createCheckoutPayment(req: Request, res: Response) {
    const userId = req.user!.id
    const checkoutId = Number(req.params.id)
    const provider = req.body.provider as PaymentProvider

    try {
        if (!Number.isSafeInteger(checkoutId) || checkoutId <= 0) {
            throw new PaymentRequestError(400, "Checkout ID must be a positive whole number")
        }

        if (!paymentProviders.includes(provider)) {
            throw new PaymentRequestError(400, "Provider must be PAYSTACK or FLUTTERWAVE")
        }

        if (!availablePaymentProviders.includes(provider)) {
            throw new PaymentRequestError(
                400,
                `${paymentProviderNames[provider]} payments are not available yet`,
                "PAYMENT_PROVIDER_NOT_AVAILABLE"
            )
        }

        await expireExpiredCheckouts(userId)

        const unstartedAttempt = await prisma.paymentAttempt.findFirst({
            where: {
                checkoutId,
                checkout: { userId },
                status: "PENDING",
                authorizationUrl: null,
                createdAt: { lte: new Date(Date.now() - initializingGraceMs) }
            }
        })

        if (unstartedAttempt) {
            await syncPayment(unstartedAttempt)
        }

        const prepared = await prisma.$transaction(async (tx) => {
            await acquireCheckoutCreationLock(tx, userId)

            const now = new Date()
            const checkout = await tx.checkout.findFirst({
                where: { id: checkoutId, userId },
                include: {
                    user: { select: { email: true } },
                    orders: {
                        orderBy: { id: "asc" },
                        select: {
                            status: true,
                            total: true,
                            seller: {
                                select: {
                                    sellerProfile: {
                                        select: {
                                            businessName: true,
                                            payoutAccounts: {
                                                where: { provider, status: "ACTIVE" },
                                                select: { subaccountCode: true }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    inventoryReservations: { select: { status: true, expiresAt: true } },
                    paymentAttempts: { orderBy: { id: "desc" } }
                }
            })

            if (!checkout) {
                throw new PaymentRequestError(404, "Checkout not found")
            }

            if (checkout.status === "COMPLETED" || checkout.paymentAttempts.some((attempt) => attempt.status === "SUCCESS")) {
                throw new PaymentRequestError(409, "This checkout has already been paid", "PAYMENT_ALREADY_COMPLETED")
            }

            if (checkout.status === "EXPIRED" || checkout.expiresAt <= now) {
                throw new PaymentRequestError(
                    409,
                    "This checkout has expired. Return to your cart to check out again.",
                    "CHECKOUT_EXPIRED"
                )
            }

            const pendingAttempt = checkout.paymentAttempts.find((attempt) => attempt.status === "PENDING")

            if (pendingAttempt) {
                if (pendingAttempt.provider !== provider) {
                    throw new PaymentRequestError(
                        409,
                        `A ${paymentProviderNames[pendingAttempt.provider]} payment is already in progress for this checkout`,
                        "PAYMENT_IN_PROGRESS"
                    )
                }

                if (!pendingAttempt.authorizationUrl) {
                    throw new PaymentRequestError(
                        409,
                        "Your payment is still being started. Try again in a moment.",
                        "PAYMENT_INITIALIZING"
                    )
                }

                return { kind: "existing" as const, attempt: pendingAttempt, checkout }
            }

            if (
                checkout.orders.length === 0 ||
                checkout.orders.some((order) => order.status !== "PENDING_PAYMENT") ||
                checkout.inventoryReservations.length === 0 ||
                checkout.inventoryReservations.some((reservation) =>
                    reservation.status !== "ACTIVE" || reservation.expiresAt <= now)
            ) {
                throw new PaymentRequestError(409, "This checkout cannot be paid", "CHECKOUT_NOT_PAYABLE")
            }

            const sellersNotReady = checkout.orders
                .filter((order) => !order.seller.sellerProfile?.payoutAccounts[0]?.subaccountCode)
                .map((order) => order.seller.sellerProfile?.businessName ?? "A seller")

            if (sellersNotReady.length > 0) {
                throw new PaymentRequestError(
                    409,
                    `Some sellers in this checkout cannot accept ${paymentProviderNames[provider]} payments yet`,
                    "PAYMENT_SELLER_NOT_READY",
                    { sellers: sellersNotReady }
                )
            }

            const splits = checkout.orders.map((order) => ({
                subaccountCode: order.seller.sellerProfile!.payoutAccounts[0]!.subaccountCode!,
                amountKobo: toKobo(order.total)
            }))
            const amountKobo = toKobo(checkout.total)

            if (splits.reduce((sum, split) => sum + split.amountKobo, 0) !== amountKobo) {
                throw new Error(`Checkout ${checkout.id} total does not equal the sum of its orders`)
            }

            const reference = `VND-${checkout.id}-${randomBytes(6).toString("hex")}`
            const attempt = await tx.paymentAttempt.create({
                data: {
                    checkoutId: checkout.id,
                    provider,
                    reference,
                    amount: checkout.total,
                    currency: "NGN",
                    status: "PENDING"
                }
            })
            const extendedExpiry = new Date(Math.max(checkout.expiresAt.getTime(), now.getTime() + paymentWindowMs))
            const updatedCheckout = await tx.checkout.update({
                where: { id: checkout.id },
                data: { status: "PAYMENT_PENDING", expiresAt: extendedExpiry }
            })
            await tx.inventoryReservation.updateMany({
                where: { checkoutId: checkout.id, status: "ACTIVE" },
                data: { expiresAt: extendedExpiry }
            })

            return {
                kind: "new" as const,
                attempt,
                checkout: updatedCheckout,
                initialization: {
                    reference,
                    amountKobo,
                    email: checkout.user.email,
                    callbackUrl: `${config.frontendUrl}/checkout/payment-return`,
                    splits: splits.filter((split) => split.amountKobo > 0)
                }
            }
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        })

        if (prepared.kind === "existing") {
            res.send({ code: "PAYMENT_REUSED", payment: toPaymentResponse(prepared.attempt, prepared.checkout) })
            return
        }

        try {
            const { authorizationUrl } = await getPaymentProvider(provider).initializePayment(prepared.initialization)
            await prisma.paymentAttempt.updateMany({
                where: { id: prepared.attempt.id, status: "PENDING" },
                data: { authorizationUrl }
            })
            res.status(201).send({
                code: "PAYMENT_STARTED",
                payment: toPaymentResponse({ ...prepared.attempt, authorizationUrl }, prepared.checkout)
            })
        } catch (error) {
            const rejected = error instanceof PaymentProviderError && error.kind === "rejected"
            console.error("Payment initialization failed", {
                reference: prepared.attempt.reference,
                provider,
                reason: error instanceof PaymentProviderError ? error.providerMessage ?? error.message : undefined
            })

            // A rejected request created no transaction, so the attempt is closed. Any other failure
            // leaves the outcome unknown: the attempt stays PENDING and is reconciled on the next try.
            if (rejected) {
                await prisma.paymentAttempt.updateMany({
                    where: { id: prepared.attempt.id, status: "PENDING" },
                    data: { status: "FAILED", failureReason: `${paymentProviderNames[provider]} rejected the payment request` }
                })
                throw new PaymentRequestError(
                    502,
                    `${paymentProviderNames[provider]} could not start this payment. Try again or choose another provider.`,
                    "PAYMENT_PROVIDER_REJECTED"
                )
            }

            throw new PaymentRequestError(
                502,
                `We could not reach ${paymentProviderNames[provider]}. Try again.`,
                "PAYMENT_PROVIDER_UNAVAILABLE"
            )
        }
    } catch (error) {
        if (!sendPaymentRequestError(error, res)) {
            throw error
        }
    }
}

// Returns the authoritative status of one of the consumer's payments. A PENDING payment is
// verified with the provider first, and a verified payment is settled if it is not yet; if the
// provider cannot be reached the saved status is returned.
// The browser's return from the payment page is never treated as proof of payment.
export async function getPayment(req: Request, res: Response) {
    const reference = String(req.params.reference)
    const where = { reference, checkout: { userId: req.user!.id } }
    const include = { checkout: { select: { id: true, status: true, expiresAt: true } } }
    let attempt = await prisma.paymentAttempt.findFirst({ where, include })

    if (!attempt) {
        res.status(404).send({ message: "Payment not found" })
        return
    }

    if (attempt.status === "PENDING" || (attempt.status === "SUCCESS" && attempt.checkout.status !== "COMPLETED")) {
        try {
            await syncPayment(attempt)
        } catch (error) {
            // An unreachable provider is not an error for the client: the saved status is returned.
            if (error instanceof PaymentProviderError) {
                console.error("Payment verification failed", {
                    reference,
                    reason: error.providerMessage ?? error.message
                })
            } else if (!(error instanceof PaymentRequestError)) {
                throw error
            }
        }

        attempt = await prisma.paymentAttempt.findFirstOrThrow({ where, include })
    }

    res.send({ payment: toPaymentResponse(attempt, attempt.checkout) })
}
