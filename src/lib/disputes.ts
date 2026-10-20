import prisma from "./prisma.js"
import { Prisma, type DisputeReason, type DisputeStatus } from "../generated/prisma/client.js"

// How the complaint process behaves. These are policy choices the owner can change.
export const disputeWindowDays = 30
export const sellerResponseHours = 72
// An order the seller never shipped can be reported as not received only after this many days.
export const unshippedDisputeAfterDays = 7
export const maximumDisputeMessages = 50
export const maximumEvidenceLinks = 5
export const minimumMessageLength = 10
export const maximumMessageLength = 2000

const dayMs = 24 * 60 * 60 * 1000
const disputeLockNamespace = 1447380561
const paidOrderStatuses: string[] = ["PAID", "SHIPPED", "DELIVERED"]

// Complaints that still need someone to act or decide.
export const activeDisputeStatuses: DisputeStatus[] = ["OPEN", "SELLER_AGREED", "UNDER_REVIEW"]
export const buyerDisputeReasons: DisputeReason[] = ["NOT_RECEIVED", "NOT_AS_DESCRIBED", "DAMAGED", "WRONG_ITEM", "OTHER"]

export const disputeReasonLabels: Record<DisputeReason, string> = {
    NOT_RECEIVED: "Order not received",
    NOT_AS_DESCRIBED: "Item not as described",
    DAMAGED: "Item damaged",
    WRONG_ITEM: "Wrong item received",
    OTHER: "Other complaint",
    SELLER_REFUND_OFFER: "Refund offered by the seller"
}

export type DisputeErrorCode =
    | "DISPUTE_NOT_ALLOWED"
    | "DISPUTE_EXISTS"
    | "DISPUTE_ALREADY_DECIDED"
    | "DISPUTE_AMOUNT_INVALID"
    | "DISPUTE_NOT_OPEN"
    | "DISPUTE_CLOSED"
    | "DISPUTE_MESSAGE_LIMIT"

export class DisputeRequestError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
        readonly code?: DisputeErrorCode,
        readonly details: Record<string, unknown> = {}
    ) {
        super(message)
    }
}

export type DisputeActor =
    | { party: "BUYER"; userId: number }
    | { party: "SELLER"; userId: number }
    | { party: "ADMIN"; userId: number }

function toKobo(amount: Prisma.Decimal): number {
    return amount.times(100).toNumber()
}

function fromKobo(kobo: number): Prisma.Decimal {
    return new Prisma.Decimal(kobo).dividedBy(100)
}

// An amount in naira with at most two decimals, as kobo. Undefined means "not supplied", null means invalid.
export function parseNairaToKobo(value: unknown): number | undefined | null {
    if (value === undefined || value === null) {
        return undefined
    }

    if (typeof value !== "number" && typeof value !== "string") {
        return null
    }

    const text = String(value).trim()

    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
        return null
    }

    const kobo = new Prisma.Decimal(text).times(100).toNumber()
    return Number.isSafeInteger(kobo) && kobo > 0 ? kobo : null
}

// A message from a complaint: trimmed, with a sensible length. Null when it is not acceptable.
export function parseMessageBody(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }

    const text = value.trim()
    return text.length >= minimumMessageLength && text.length <= maximumMessageLength ? text : null
}

// Links to evidence the sender has already uploaded: up to five https addresses. Null when invalid.
export function parseEvidenceUrls(value: unknown): string[] | null {
    if (value === undefined || value === null) {
        return []
    }

    if (!Array.isArray(value) || value.length > maximumEvidenceLinks) {
        return null
    }

    const urls: string[] = []

    for (const entry of value) {
        if (typeof entry !== "string" || entry.length > 500) {
            return null
        }

        try {
            if (new URL(entry).protocol !== "https:") {
                return null
            }
        } catch {
            return null
        }

        urls.push(entry)
    }

    return urls
}

// Money the buyer could still be refunded for an order, in kobo.
function remainingKobo(order: { total: Prisma.Decimal; refunds: Array<{ amount: Prisma.Decimal; status: string }> }): number {
    const refunded = order.refunds
        .filter((refund) => refund.status !== "FAILED")
        .reduce((sum, refund) => sum + toKobo(refund.amount), 0)

    return toKobo(order.total) - refunded
}

type OpenDisputeInput = {
    actor: { party: "BUYER" | "SELLER"; userId: number }
    orderId: number
    // The checkout the buyer's request named, which must be the order's own.
    checkoutId?: number
    reason: DisputeReason
    message: string
    evidenceUrls: string[]
    // Null asks for everything still refundable.
    requestedKobo: number | null
}

// Opens a complaint about a paid seller order, or a refund the seller offers. A buyer's complaint
// waits for the seller; a seller's offer is already agreed and waits for an administrator.
export async function openDispute(input: OpenDisputeInput): Promise<number> {
    const { actor } = input
    const order = await prisma.order.findFirst({
        where: actor.party === "BUYER"
            ? {
                id: input.orderId,
                ...(input.checkoutId === undefined ? {} : { checkoutId: input.checkoutId }),
                checkout: { userId: actor.userId }
            }
            : { id: input.orderId, sellerId: actor.userId },
        include: {
            checkout: { select: { paymentAttempts: { where: { status: "SUCCESS" }, orderBy: { id: "asc" }, take: 1, select: { verifiedAt: true } } } },
            refunds: { select: { amount: true, status: true } }
        }
    })

    if (!order) {
        throw new DisputeRequestError(404, "Order not found")
    }

    if (order.status === "REFUNDED") {
        throw new DisputeRequestError(409, "This order has already been refunded", "DISPUTE_NOT_ALLOWED")
    }

    if (!paidOrderStatuses.includes(order.status)) {
        throw new DisputeRequestError(409, "Only paid orders can have a complaint", "DISPUTE_NOT_ALLOWED")
    }

    if (actor.party === "BUYER") {
        const paidAt = order.checkout.paymentAttempts[0]?.verifiedAt ?? order.createdAt
        const sincePaid = Date.now() - paidAt.getTime()

        if (sincePaid > disputeWindowDays * dayMs) {
            throw new DisputeRequestError(
                409,
                `The ${disputeWindowDays}-day period for complaints about this order has ended`,
                "DISPUTE_NOT_ALLOWED"
            )
        }

        if (input.reason === "NOT_RECEIVED") {
            if (order.status === "DELIVERED") {
                throw new DisputeRequestError(409, "You confirmed that you received this order", "DISPUTE_NOT_ALLOWED")
            }

            if (order.status === "PAID" && sincePaid < unshippedDisputeAfterDays * dayMs) {
                throw new DisputeRequestError(
                    409,
                    `The seller has not shipped this order yet. You can report it as not received if it has not shipped ${unshippedDisputeAfterDays} days after payment.`,
                    "DISPUTE_NOT_ALLOWED"
                )
            }
        } else if (order.status === "PAID") {
            throw new DisputeRequestError(409, "You can complain about the item once the seller has shipped it", "DISPUTE_NOT_ALLOWED")
        }
    }

    const remaining = remainingKobo(order)
    const requestedKobo = input.requestedKobo ?? remaining

    if (remaining <= 0) {
        throw new DisputeRequestError(409, "Everything on this order has already been refunded", "DISPUTE_NOT_ALLOWED")
    }

    if (requestedKobo <= 0 || requestedKobo > remaining) {
        throw new DisputeRequestError(
            400,
            `The amount must be between ₦0.01 and ₦${fromKobo(remaining).toFixed(2)}`,
            "DISPUTE_AMOUNT_INVALID",
            { maximum: fromKobo(remaining).toFixed(2) }
        )
    }

    const now = new Date()
    const offeredBySeller = actor.party === "SELLER"

    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${disputeLockNamespace}::integer, ${order.id}::integer)`

        const existing = await tx.dispute.findMany({ where: { orderId: order.id }, select: { id: true, status: true, outcome: true } })
        const active = existing.find((dispute) => activeDisputeStatuses.includes(dispute.status))

        if (active) {
            throw new DisputeRequestError(409, "There is already an open complaint about this order", "DISPUTE_EXISTS", { disputeId: active.id })
        }

        if (!offeredBySeller && existing.some((dispute) => dispute.outcome === "REJECTED")) {
            throw new DisputeRequestError(
                409,
                "Vendly has already reviewed and rejected a complaint about this order",
                "DISPUTE_ALREADY_DECIDED"
            )
        }

        const dispute = await tx.dispute.create({
            data: {
                orderId: order.id,
                openedBy: actor.party,
                reason: input.reason,
                requestedAmount: fromKobo(requestedKobo),
                status: offeredBySeller ? "SELLER_AGREED" : "OPEN",
                responseDueAt: new Date(now.getTime() + sellerResponseHours * 60 * 60 * 1000),
                sellerRespondedAt: offeredBySeller ? now : null
            }
        })
        await tx.disputeMessage.create({
            data: {
                disputeId: dispute.id,
                author: actor.party,
                authorId: actor.userId,
                body: input.message,
                evidenceUrls: input.evidenceUrls
            }
        })

        return dispute.id
    })
}

// The seller answers a buyer's complaint: agreeing sends it to an administrator to approve the
// refund; disagreeing sends it to an administrator to decide. Either way the seller's reply is
// added to the thread.
export async function respondToDispute(input: {
    disputeId: number
    sellerId: number
    action: "AGREE_TO_REFUND" | "DISAGREE"
    message: string
    evidenceUrls: string[]
}): Promise<void> {
    const dispute = await prisma.dispute.findFirst({
        where: { id: input.disputeId, order: { sellerId: input.sellerId } },
        select: { id: true, status: true }
    })

    if (!dispute) {
        throw new DisputeRequestError(404, "Complaint not found")
    }

    if (dispute.status !== "OPEN") {
        throw new DisputeRequestError(409, "This complaint is not waiting for your answer", "DISPUTE_NOT_OPEN")
    }

    await prisma.$transaction(async (tx) => {
        const now = new Date()
        const moved = await tx.dispute.updateMany({
            where: { id: dispute.id, status: "OPEN" },
            data: input.action === "AGREE_TO_REFUND"
                ? { status: "SELLER_AGREED", sellerRespondedAt: now }
                : { status: "UNDER_REVIEW", sellerRespondedAt: now, escalatedAt: now }
        })

        if (moved.count !== 1) {
            throw new DisputeRequestError(409, "This complaint is not waiting for your answer", "DISPUTE_NOT_OPEN")
        }

        await tx.disputeMessage.create({
            data: {
                disputeId: dispute.id,
                author: "SELLER",
                authorId: input.sellerId,
                body: input.message,
                evidenceUrls: input.evidenceUrls
            }
        })
    })
}

// Adds a message to an active complaint's shared thread. The buyer and seller must be the ones
// the complaint is about; an administrator may write on any.
export async function addDisputeMessage(input: {
    disputeId: number
    actor: DisputeActor
    message: string
    evidenceUrls: string[]
}): Promise<void> {
    const { actor } = input
    const dispute = await prisma.dispute.findFirst({
        where: {
            id: input.disputeId,
            ...(actor.party === "BUYER" ? { order: { checkout: { userId: actor.userId } } } : {}),
            ...(actor.party === "SELLER" ? { order: { sellerId: actor.userId } } : {})
        },
        select: { id: true, status: true, _count: { select: { messages: true } } }
    })

    if (!dispute) {
        throw new DisputeRequestError(404, "Complaint not found")
    }

    if (!activeDisputeStatuses.includes(dispute.status)) {
        throw new DisputeRequestError(409, "This complaint is closed", "DISPUTE_CLOSED")
    }

    if (dispute._count.messages >= maximumDisputeMessages) {
        throw new DisputeRequestError(409, "This complaint has reached its message limit", "DISPUTE_MESSAGE_LIMIT")
    }

    await prisma.disputeMessage.create({
        data: {
            disputeId: dispute.id,
            author: actor.party,
            authorId: actor.userId,
            body: input.message,
            evidenceUrls: input.evidenceUrls
        }
    })
}

// Whoever opened a complaint can take it back while it is still active.
export async function withdrawDispute(input: { disputeId: number; actor: { party: "BUYER" | "SELLER"; userId: number } }): Promise<void> {
    const { actor } = input
    const dispute = await prisma.dispute.findFirst({
        where: {
            id: input.disputeId,
            openedBy: actor.party,
            ...(actor.party === "BUYER" ? { order: { checkout: { userId: actor.userId } } } : { order: { sellerId: actor.userId } })
        },
        select: { id: true, status: true }
    })

    if (!dispute) {
        throw new DisputeRequestError(404, "Complaint not found")
    }

    if (!activeDisputeStatuses.includes(dispute.status)) {
        throw new DisputeRequestError(409, "This complaint is already closed", "DISPUTE_CLOSED")
    }

    await prisma.$transaction(async (tx) => {
        const moved = await tx.dispute.updateMany({
            where: { id: dispute.id, status: { in: activeDisputeStatuses } },
            data: { status: "WITHDRAWN", resolvedAt: new Date() }
        })

        if (moved.count !== 1) {
            throw new DisputeRequestError(409, "This complaint is already closed", "DISPUTE_CLOSED")
        }

        await tx.disputeMessage.create({
            data: {
                disputeId: dispute.id,
                author: "SYSTEM",
                body: actor.party === "BUYER" ? "The buyer withdrew this complaint." : "The seller withdrew this refund offer."
            }
        })
    })
}

// An administrator turns a complaint down, with a note both sides can read.
export async function rejectDispute(input: { disputeId: number; adminId: number; note: string }): Promise<void> {
    const dispute = await prisma.dispute.findUnique({ where: { id: input.disputeId }, select: { id: true, status: true } })

    if (!dispute) {
        throw new DisputeRequestError(404, "Complaint not found")
    }

    await prisma.$transaction(async (tx) => {
        const moved = await tx.dispute.updateMany({
            where: { id: dispute.id, status: { in: activeDisputeStatuses } },
            data: { status: "RESOLVED", outcome: "REJECTED", decisionNote: input.note, decidedById: input.adminId, resolvedAt: new Date() }
        })

        if (moved.count !== 1) {
            throw new DisputeRequestError(409, "This complaint is already closed", "DISPUTE_CLOSED")
        }

        await tx.disputeMessage.create({
            data: { disputeId: dispute.id, author: "ADMIN", authorId: input.adminId, body: input.note }
        })
    })
}

// Passes complaints the seller has not answered in time to an administrator. Each is moved once
// and noted in its thread; a complaint the seller already answered is never touched. Returns how
// many were moved.
export async function escalateOverdueDisputes(now = new Date()): Promise<number> {
    const overdue = await prisma.dispute.findMany({
        where: { status: "OPEN", responseDueAt: { lte: now } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: 50
    })
    let escalated = 0

    for (const { id } of overdue) {
        const moved = await prisma.$transaction(async (tx) => {
            const result = await tx.dispute.updateMany({
                where: { id, status: "OPEN", responseDueAt: { lte: now } },
                data: { status: "UNDER_REVIEW", escalatedAt: now }
            })

            if (result.count === 1) {
                await tx.disputeMessage.create({
                    data: {
                        disputeId: id,
                        author: "SYSTEM",
                        body: "The seller did not answer in time, so this has been passed to Vendly for a decision."
                    }
                })
            }

            return result.count === 1
        })

        if (moved) {
            escalated++
        }
    }

    return escalated
}
