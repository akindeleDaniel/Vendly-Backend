import { randomBytes } from "node:crypto"
import prisma from "../prisma.js"
import { Prisma, type PaymentAttempt, type Order, type Refund, type RefundStatus } from "../../generated/prisma/client.js"
import { activeDisputeStatuses } from "../disputes.js"
import { getPaymentProvider } from "./providers.js"
import { PaymentProviderError, type ProviderRefund } from "./types.js"
import { notifyRefundProgress, notifySellerCharged, queueNotification } from "../notifications.js"
import { reviewSellerStanding } from "../sellerStanding.js"

// Statuses of an order that has been paid and not fully refunded.
const refundableOrderStatuses: string[] = ["PAID", "SHIPPED", "DELIVERED"]
const openRefundStatuses: RefundStatus[] = ["PENDING", "PROCESSING", "NEEDS_ATTENTION"]
const orderLockNamespace = 1447380559
const paymentLockNamespace = 1447380560
// A refund the provider never confirmed is given this long to show up before it is closed as failed.
const unknownOutcomeGraceMs = 15 * 60 * 1000
// A refund checked more recently than this (by anything) is left alone by the periodic check.
const recheckAfterMs = 4 * 60 * 1000
const maximumRefundsPerRun = 20

export type RefundErrorCode =
    | "REFUND_TARGET_NOT_FOUND"
    | "REFUND_NOT_ALLOWED"
    | "REFUND_IN_PROGRESS"
    | "REFUND_AMOUNT_INVALID"
    | "REFUND_RESTOCK_NOT_ALLOWED"
    | "REFUND_BALANCE_LOW"
    | "REFUND_CONFLICT"
    | "REFUND_PROVIDER_REJECTED"
    | "REFUND_PROVIDER_UNAVAILABLE"

export class RefundRequestError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
        readonly code: RefundErrorCode,
        readonly details: Record<string, unknown> = {}
    ) {
        super(message)
    }
}

export type IssueRefundInput = {
    adminId: number
    // A refund covers one seller's order, or (to clear a recovery case) a whole payment.
    target: { orderId: number } | { paymentAttemptId: number }
    // Null refunds everything still refundable.
    amountKobo: number | null
    // Shown to the seller if they are charged for the refund.
    reason: string
    // Shown to the buyer.
    customerNote: string | null
    // Null chooses the default: restock when the whole order is refunded before it shipped.
    restock: boolean | null
    // Null charges the seller (an order refund). A payment refund never charges a seller.
    chargeSeller: boolean | null
    acknowledgeLowBalance: boolean
    // The complaint this refund settles, when it comes from one.
    disputeId?: number | null
}

function toKobo(amount: Prisma.Decimal): number {
    return amount.times(100).toNumber()
}

function fromKobo(kobo: number): Prisma.Decimal {
    return new Prisma.Decimal(kobo).dividedBy(100)
}

function formatNaira(kobo: number): string {
    return fromKobo(kobo).toFixed(2)
}

type RefundTarget = {
    order: (Order & { orderItems: Array<{ listingId: number; quantity: number }> }) | null
    attempt: PaymentAttempt
    totalKobo: number
}

async function loadTarget(target: IssueRefundInput["target"]): Promise<RefundTarget> {
    if ("orderId" in target) {
        const order = await prisma.order.findUnique({
            where: { id: target.orderId },
            include: {
                orderItems: { select: { listingId: true, quantity: true } },
                checkout: {
                    select: { paymentAttempts: { where: { status: "SUCCESS" }, orderBy: { id: "asc" }, take: 1 } }
                }
            }
        })

        if (!order) {
            throw new RefundRequestError(404, "Order not found", "REFUND_TARGET_NOT_FOUND")
        }

        if (order.status === "REFUNDED") {
            throw new RefundRequestError(409, "This order has already been fully refunded", "REFUND_NOT_ALLOWED")
        }

        if (!refundableOrderStatuses.includes(order.status)) {
            throw new RefundRequestError(409, "Only paid orders can be refunded", "REFUND_NOT_ALLOWED")
        }

        const attempt = order.checkout.paymentAttempts[0]

        if (!attempt) {
            throw new RefundRequestError(409, "This order has no verified payment to refund", "REFUND_NOT_ALLOWED")
        }

        return { order, attempt, totalKobo: toKobo(order.total) }
    }

    const attempt = await prisma.paymentAttempt.findUnique({
        where: { id: target.paymentAttemptId },
        include: { checkout: { select: { orders: { select: { status: true } } } } }
    })

    if (!attempt) {
        throw new RefundRequestError(404, "Payment not found", "REFUND_TARGET_NOT_FOUND")
    }

    if (attempt.status !== "SUCCESS") {
        throw new RefundRequestError(409, "Only a successful payment can be refunded", "REFUND_NOT_ALLOWED")
    }

    if (attempt.checkout.orders.some((order) => order.status !== "PENDING_PAYMENT" && order.status !== "CANCELLED")) {
        throw new RefundRequestError(409, "This payment completed an order, so refund the order instead", "REFUND_NOT_ALLOWED")
    }

    return { order: null, attempt, totalKobo: toKobo(attempt.amount) }
}

// Works out the amount and options of a refund from what has already been refunded, or says why it
// cannot be done. Used once to check the balance and again, under a lock, when the refund is saved.
function planRefund(
    target: RefundTarget,
    existing: Array<{ amount: Prisma.Decimal; status: RefundStatus }>,
    input: IssueRefundInput
) {
    if (existing.some((refund) => openRefundStatuses.includes(refund.status))) {
        throw new RefundRequestError(409, "A refund for this is already in progress", "REFUND_IN_PROGRESS")
    }

    const counted = existing.filter((refund) => refund.status !== "FAILED")
    const refundedKobo = counted.reduce((sum, refund) => sum + toKobo(refund.amount), 0)
    const remainingKobo = target.totalKobo - refundedKobo

    if (remainingKobo <= 0) {
        throw new RefundRequestError(409, "Everything has already been refunded", "REFUND_NOT_ALLOWED")
    }

    const amountKobo = input.amountKobo ?? remainingKobo

    if (!target.order && amountKobo !== target.totalKobo) {
        throw new RefundRequestError(400, "A payment refund must be for the full payment amount", "REFUND_AMOUNT_INVALID")
    }

    if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0 || amountKobo > remainingKobo) {
        throw new RefundRequestError(
            400,
            `The refund must be between ₦0.01 and ₦${formatNaira(remainingKobo)}`,
            "REFUND_AMOUNT_INVALID",
            { maximum: formatNaira(remainingKobo) }
        )
    }

    // Stock only goes back when the whole order is refunded, because a partial refund does not say which items.
    const isWholeOrder = target.order !== null && amountKobo === target.totalKobo && counted.length === 0
    const restock = input.restock ?? (isWholeOrder && target.order?.status === "PAID")

    if (restock && !isWholeOrder) {
        throw new RefundRequestError(
            400,
            "Items can only be restocked when the whole order is refunded in one go",
            "REFUND_RESTOCK_NOT_ALLOWED"
        )
    }

    return { amountKobo, restock, chargeSeller: target.order !== null && (input.chargeSeller ?? true) }
}

function refundWhere(target: RefundTarget): Prisma.RefundWhereInput {
    return target.order ? { orderId: target.order.id } : { paymentAttemptId: target.attempt.id, orderId: null }
}

// Issues a refund through the provider that took the payment. The refund is saved before the provider
// is called, and nothing is retried after an unknown outcome (a retry could refund twice): it stays
// PENDING until syncRefund finds it at the provider or closes it.
export async function issueRefund(input: IssueRefundInput): Promise<Refund> {
    const target = await loadTarget(input.target)
    const adapter = getPaymentProvider(target.attempt.provider)

    const preview = planRefund(
        target,
        await prisma.refund.findMany({ where: refundWhere(target), select: { amount: true, status: true } }),
        input
    )

    // Both providers refund from StoreHatch's own balance, so warn before a refund that it cannot cover.
    let balanceKobo: number | null = null

    try {
        balanceKobo = await adapter.getBalanceKobo()
    } catch (error) {
        console.error("Could not read the provider balance before a refund", {
            provider: target.attempt.provider,
            reason: error instanceof PaymentProviderError ? error.providerMessage ?? error.message : undefined
        })
    }

    if (balanceKobo !== null && balanceKobo < preview.amountKobo && !input.acknowledgeLowBalance) {
        throw new RefundRequestError(
            409,
            "StoreHatch's balance at the payment provider is lower than this refund. Add funds, or confirm to queue it anyway.",
            "REFUND_BALANCE_LOW",
            { availableBalance: formatNaira(balanceKobo), required: formatNaira(preview.amountKobo) }
        )
    }

    let refund: Refund

    try {
        refund = await prisma.$transaction(async (tx) => {
            const lockNamespace = target.order ? orderLockNamespace : paymentLockNamespace
            const lockId = target.order ? target.order.id : target.attempt.id
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockNamespace}::integer, ${lockId}::integer)`

            const plan = planRefund(
                target,
                await tx.refund.findMany({ where: refundWhere(target), select: { amount: true, status: true } }),
                input
            )

            return tx.refund.create({
                data: {
                    orderId: target.order?.id ?? null,
                    paymentAttemptId: target.attempt.id,
                    provider: target.attempt.provider,
                    reference: `RFD-${randomBytes(8).toString("hex")}`,
                    amount: fromKobo(plan.amountKobo),
                    currency: target.attempt.currency,
                    reason: input.reason,
                    customerNote: input.customerNote,
                    restock: plan.restock,
                    chargeSeller: plan.chargeSeller,
                    requestedById: input.adminId,
                    disputeId: input.disputeId ?? null
                }
            })
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
            throw new RefundRequestError(409, "Another refund changed this at the same moment. Try again.", "REFUND_CONFLICT")
        }

        throw error
    }

    let providerRefund: ProviderRefund

    try {
        providerRefund = await adapter.createRefund({
            transactionReference: target.attempt.reference,
            transactionId: target.attempt.providerTransactionId,
            amountKobo: toKobo(refund.amount),
            customerNote: refund.customerNote,
            merchantNote: `StoreHatch refund ${refund.reference}`
        })
    } catch (error) {
        const reason = error instanceof PaymentProviderError ? error.providerMessage ?? error.message : undefined
        console.error("Refund request failed", { refund: refund.reference, provider: refund.provider, reason })

        if (error instanceof PaymentProviderError && error.kind === "rejected") {
            await prisma.refund.updateMany({
                where: { id: refund.id, status: "PENDING" },
                data: { status: "FAILED", failureReason: "The payment provider rejected the refund", lastCheckedAt: new Date() }
            })
            throw new RefundRequestError(502, "The payment provider rejected the refund", "REFUND_PROVIDER_REJECTED", {
                refundReference: refund.reference
            })
        }

        throw new RefundRequestError(
            502,
            "The payment provider could not be reached, so it is not known whether the refund was started. It will be checked again; do not issue it twice.",
            "REFUND_PROVIDER_UNAVAILABLE",
            { refundReference: refund.reference }
        )
    }

    await applyProviderRefund(refund.id, providerRefund)
    return prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
}

// Records what the provider reports for a refund and applies each state change exactly once. Every
// write is conditional on the refund still being open, so webhooks, the periodic check and an
// admin's check can all run without repeating any effect.
async function applyProviderRefund(refundId: number, providerRefund: ProviderRefund): Promise<void> {
    const status: RefundStatus = providerRefund.outcome === "succeeded"
        ? "SUCCEEDED"
        : providerRefund.outcome === "failed"
            ? "FAILED"
            : providerRefund.outcome === "needs_attention" ? "NEEDS_ATTENTION" : "PROCESSING"
    const now = new Date()
    // What changed, so the people involved are told once, after it is saved, and not on every later check.
    let progressedTo = null as "PROCESSING" | "SUCCEEDED" | "FAILED" | "NEEDS_ATTENTION" | null
    let sellerCharged = false as boolean
    let reviewSeller = null as number | null

    await prisma.$transaction(async (tx) => {
        const refund = await tx.refund.findUniqueOrThrow({
            where: { id: refundId },
            include: { order: { include: { orderItems: { select: { listingId: true, quantity: true } } } } }
        })

        if (!openRefundStatuses.includes(refund.status)) {
            return
        }

        const moved = await tx.refund.updateMany({
            where: { id: refundId, status: { in: openRefundStatuses } },
            data: {
                status,
                providerRefundId: providerRefund.providerRefundId,
                providerStatus: providerRefund.providerStatus,
                awaitingFunds: providerRefund.awaitingFunds,
                expectedAt: providerRefund.expectedAt,
                lastCheckedAt: now,
                failureReason: status === "FAILED" ? "The payment provider could not complete the refund" : null,
                completedAt: status === "SUCCEEDED" || status === "FAILED" ? now : null
            }
        })

        if (moved.count !== 1) {
            return
        }

        if (status !== refund.status) {
            progressedTo = status
        }

        if (status === "FAILED") {
            await voidLiability(tx, refundId)
            return
        }

        // Once StoreHatch's money has gone to the buyer, the seller owes it back.
        if (refund.chargeSeller && refund.order) {
            const created = await tx.sellerLiability.createMany({
                data: [{ sellerId: refund.order.sellerId, refundId, amount: refund.amount }],
                skipDuplicates: true
            })
            sellerCharged = created.count === 1
        }

        if ((await resolveDisputesForRefund(tx, refund, now)) > 0 && refund.order) {
            reviewSeller = refund.order.sellerId
        }

        if (status === "SUCCEEDED") {
            await completeRefund(tx, refund)
        }
    })

    if (reviewSeller !== null) {
        // A lost complaint is a strike: warn or block the shop if it has reached the limit.
        const sellerId = reviewSeller
        queueNotification("seller standing", () => reviewSellerStanding(sellerId))
    }

    if (progressedTo) {
        const reached = progressedTo
        queueNotification("refund progress", () => notifyRefundProgress(refundId, reached))
    }

    if (sellerCharged) {
        queueNotification("seller charged", () => notifySellerCharged(refundId))
    }
}

// A refund the provider has accepted settles the complaint it was for, and any other open complaint
// about the same order. A refund that fails leaves the complaint open so it can be approved again.
async function resolveDisputesForRefund(tx: Prisma.TransactionClient, refund: Refund, now: Date): Promise<number> {
    const matching: Prisma.DisputeWhereInput[] = []

    if (refund.disputeId) {
        matching.push({ id: refund.disputeId })
    }

    if (refund.orderId) {
        matching.push({ orderId: refund.orderId })
    }

    if (matching.length === 0) {
        return 0
    }

    let resolved = 0
    const open = await tx.dispute.findMany({
        where: { status: { in: activeDisputeStatuses }, OR: matching },
        select: { id: true }
    })

    for (const { id } of open) {
        const moved = await tx.dispute.updateMany({
            where: { id, status: { in: activeDisputeStatuses } },
            data: {
                status: "RESOLVED",
                outcome: "REFUNDED",
                approvedAmount: refund.amount,
                decidedById: refund.requestedById,
                resolvedAt: now
            }
        })

        if (moved.count === 1) {
            resolved += 1
            await tx.disputeMessage.create({
                data: { disputeId: id, author: "SYSTEM", body: `StoreHatch approved a refund of ₦${refund.amount.toFixed(2)}.` }
            })
        }
    }

    return resolved
}

async function voidLiability(tx: Prisma.TransactionClient, refundId: number): Promise<void> {
    const liability = await tx.sellerLiability.findUnique({ where: { refundId } })

    if (!liability || liability.status !== "OPEN") {
        return
    }

    await tx.sellerLiability.update({
        where: { id: liability.id },
        data: { status: "VOID", closedAt: new Date(), note: "The refund failed, so this is no longer owed." }
    })

    if (liability.recovered.greaterThan(0)) {
        console.error("A refund failed after money was recovered from the seller for it", {
            liabilityId: liability.id,
            sellerId: liability.sellerId,
            recovered: liability.recovered.toFixed(2)
        })
    }
}

type CompletedRefund = Refund & {
    order: (Order & { orderItems: Array<{ listingId: number; quantity: number }> }) | null
}

// The refund has reached the buyer's side: update the order, put stock back if asked, and close
// the recovery case a payment refund was for.
async function completeRefund(tx: Prisma.TransactionClient, refund: CompletedRefund): Promise<void> {
    if (!refund.order) {
        // The payment never became an order, so the buyer now has their money back: cancel what was
        // waiting on it and let go of the stock still held for it.
        const attempt = await tx.paymentAttempt.findUniqueOrThrow({
            where: { id: refund.paymentAttemptId },
            select: { checkoutId: true }
        })
        await tx.order.updateMany({
            where: { checkoutId: attempt.checkoutId, status: "PENDING_PAYMENT" },
            data: { status: "CANCELLED" }
        })
        await tx.inventoryReservation.updateMany({
            where: { checkoutId: attempt.checkoutId, status: { in: ["ACTIVE", "PROTECTED"] } },
            data: { status: "RELEASED" }
        })
        await tx.paymentRecoveryCase.updateMany({
            where: { paymentAttemptId: refund.paymentAttemptId, status: "OPEN" },
            data: { status: "RESOLVED", resolvedAt: new Date(), resolutionNote: `Refunded in full (${refund.reference})` }
        })
        return
    }

    const order = await tx.order.update({
        where: { id: refund.order.id },
        data: { refundedAmount: { increment: refund.amount } }
    })

    if (order.refundedAmount.greaterThanOrEqualTo(order.total)) {
        await tx.order.updateMany({
            where: { id: order.id, status: { in: refundableOrderStatuses as Order["status"][] } },
            data: { status: "REFUNDED" }
        })
    }

    if (refund.restock) {
        // Claimed once, so stock goes back exactly once however often the refund is checked.
        const claimed = await tx.refund.updateMany({
            where: { id: refund.id, restockedAt: null },
            data: { restockedAt: new Date() }
        })

        if (claimed.count === 1) {
            for (const item of refund.order.orderItems) {
                await tx.listing.update({
                    where: { id: item.listingId },
                    data: { stockQuantity: { increment: item.quantity } }
                })
            }
        }
    }
}

// Asks the provider where a refund stands and applies the answer. A refund whose request got no
// answer (so it has no provider ID) is matched to a provider refund of the same amount made around
// then; if none turns up within a while it is closed as failed so it can be issued again.
export async function syncRefund(refundId: number): Promise<Refund> {
    const refund = await prisma.refund.findUniqueOrThrow({
        where: { id: refundId },
        include: { paymentAttempt: true }
    })

    if (!openRefundStatuses.includes(refund.status)) {
        return refund
    }

    const found = await getPaymentProvider(refund.provider).findRefunds({
        transactionReference: refund.paymentAttempt.reference,
        transactionId: refund.paymentAttempt.providerTransactionId,
        providerRefundId: refund.providerRefundId
    })
    let match: ProviderRefund | undefined

    if (refund.providerRefundId) {
        match = found.find((candidate) => candidate.providerRefundId === refund.providerRefundId)
    } else {
        const claimedElsewhere = new Set((await prisma.refund.findMany({
            where: { provider: refund.provider, providerRefundId: { in: found.map((candidate) => candidate.providerRefundId) } },
            select: { providerRefundId: true }
        })).map((other) => other.providerRefundId))
        const earliest = refund.createdAt.getTime() - 2 * 60 * 1000
        match = found.find((candidate) =>
            candidate.amountKobo === toKobo(refund.amount) &&
            !claimedElsewhere.has(candidate.providerRefundId) &&
            (candidate.createdAt === null || candidate.createdAt.getTime() >= earliest))
    }

    if (match) {
        await applyProviderRefund(refund.id, match)
    } else if (!refund.providerRefundId && Date.now() - refund.createdAt.getTime() > unknownOutcomeGraceMs) {
        await prisma.refund.updateMany({
            where: { id: refund.id, status: "PENDING", providerRefundId: null },
            data: {
                status: "FAILED",
                failureReason: "The payment provider has no record of this refund",
                completedAt: new Date(),
                lastCheckedAt: new Date()
            }
        })
    } else {
        await prisma.refund.update({ where: { id: refund.id }, data: { lastCheckedAt: new Date() } })
    }

    return prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
}

// A provider's refund webhook for one payment: re-check that payment's open refunds. The payload is
// never trusted on its own. Throws if the provider cannot be asked, so the webhook is retried.
export async function syncRefundsForPayment(provider: PaymentAttempt["provider"], reference: string): Promise<void> {
    const refunds = await prisma.refund.findMany({
        where: { provider, status: { in: openRefundStatuses }, paymentAttempt: { reference } },
        select: { id: true }
    })

    for (const refund of refunds) {
        await syncRefund(refund.id)
    }
}

// Checks refunds that have not reached a final state. Each is claimed by stamping lastCheckedAt, so
// several servers never check the same refund together. Does nothing when no refund is open.
export async function checkOpenRefunds(now = new Date()): Promise<number> {
    const recheckCutoff = new Date(now.getTime() - recheckAfterMs)
    const notRecentlyChecked = [{ lastCheckedAt: null }, { lastCheckedAt: { lte: recheckCutoff } }]
    const candidates = await prisma.refund.findMany({
        where: { status: { in: openRefundStatuses }, OR: notRecentlyChecked },
        orderBy: { id: "asc" },
        take: maximumRefundsPerRun
    })
    let checked = 0

    for (const candidate of candidates) {
        const claimed = await prisma.refund.updateMany({
            where: { id: candidate.id, status: candidate.status, OR: notRecentlyChecked },
            data: { lastCheckedAt: now }
        })

        if (claimed.count !== 1) {
            continue
        }

        checked++

        try {
            await syncRefund(candidate.id)
        } catch (error) {
            console.error("Refund check failed", {
                refund: candidate.reference,
                reason: error instanceof Error ? error.message : undefined
            })
        }
    }

    return checked
}
