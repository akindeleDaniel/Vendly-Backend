import { Prisma, type PreOrderRequest } from "../generated/prisma/client.js"
import prisma from "./prisma.js"
import { notifyPreOrderUpdate, queueNotification } from "./notifications.js"

// Pre-orders for food shops. A buyer with food in their cart asks a shop to have it ready at a time of their
// choosing; the seller approves or declines; an approved request lets the buyer pay for exactly those items, and the
// paid order carries the ready time. Nothing is charged until the buyer pays after approval, so a seller who says
// no never has to refund anyone. The complaint periods for a pre-order count from the ready time (see disputes).
export const minimumLeadHours = 6
export const maximumLeadDays = 30
export const sellerResponseHours = 48
export const paymentHoursAfterApproval = 24
// The seller cannot approve a time that is too close to be possible.
export const approveMinimumNoticeHours = 1
export const maximumNoteLength = 500
export const preOrderPageSize = 20

const hourMs = 60 * 60 * 1000
const dayMs = 24 * hourMs
const preOrderLockNamespace = 1447380562
export const openPreOrderStatuses = ["REQUESTED", "APPROVED"] as const

export class PreOrderRequestError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
        readonly code?: "PREORDER_NOT_AVAILABLE" | "PREORDER_EXISTS" | "PREORDER_CART_EMPTY" | "PREORDER_TIME_INVALID" | "PREORDER_NOT_OPEN",
        readonly details: Record<string, unknown> = {}
    ) {
        super(message)
    }
}

export type SnapshotItem = { listingId: number; quantity: number; unitPrice: string }

// ---- reading a request ----

// A date and time with its time zone (for example 2026-11-02T14:00:00+01:00, or ending in Z).
export function parseReadyAt(value: unknown): Date | null {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
        return null
    }

    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

// Undefined when there is no note; null when it is not text or too long.
export function parseNote(value: unknown): string | undefined | null {
    if (value === undefined || value === null) {
        return undefined
    }

    if (typeof value !== "string") {
        return null
    }

    const note = value.trim()
    return note.length === 0 ? undefined : note.length <= maximumNoteLength ? note : null
}

function readItems(json: Prisma.JsonValue): SnapshotItem[] {
    return Array.isArray(json)
        ? json.flatMap((entry) => {
            const item = entry as { listingId?: unknown; quantity?: unknown; unitPrice?: unknown } | null
            return item && typeof item.listingId === "number" && typeof item.quantity === "number" && typeof item.unitPrice === "string"
                ? [{ listingId: item.listingId, quantity: item.quantity, unitPrice: item.unitPrice }]
                : []
        })
        : []
}

// Whether an approved request is for exactly these cart lines at these prices.
export function snapshotMatches(snapshot: Prisma.JsonValue, current: SnapshotItem[]): boolean {
    const saved = readItems(snapshot).sort((left, right) => left.listingId - right.listingId)
    const now = [...current].sort((left, right) => left.listingId - right.listingId)

    return saved.length === now.length && saved.every((item, index) => {
        const other = now[index]
        return other !== undefined && item.listingId === other.listingId && item.quantity === other.quantity && item.unitPrice === other.unitPrice
    })
}

// ---- the buyer ----

export async function requestPreOrder(input: { buyerId: number; sellerSlug: string; readyAt: Date; note: string | undefined }): Promise<PreOrderRequest> {
    const now = new Date()

    if (input.readyAt.getTime() < now.getTime() + minimumLeadHours * hourMs) {
        throw new PreOrderRequestError(400, `Choose a time at least ${minimumLeadHours} hours from now`, "PREORDER_TIME_INVALID")
    }

    if (input.readyAt.getTime() > now.getTime() + maximumLeadDays * dayMs) {
        throw new PreOrderRequestError(400, `Choose a time within the next ${maximumLeadDays} days`, "PREORDER_TIME_INVALID")
    }

    const profile = await prisma.sellerProfile.findUnique({ where: { slug: input.sellerSlug }, select: { userId: true, foodOrderType: true, blockedAt: true } })

    // A blocked shop is hidden, so it looks the same as one that does not exist.
    if (!profile || profile.blockedAt) {
        throw new PreOrderRequestError(404, "Store not found")
    }

    if (profile.userId === input.buyerId) {
        throw new PreOrderRequestError(409, "You cannot pre-order from your own shop", "PREORDER_NOT_AVAILABLE")
    }

    if (profile.foodOrderType === "NOW") {
        throw new PreOrderRequestError(409, "This shop does not take pre-orders", "PREORDER_NOT_AVAILABLE")
    }

    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${preOrderLockNamespace}::integer, ${input.buyerId}::integer)`

        const open = await tx.preOrderRequest.findFirst({
            where: { buyerId: input.buyerId, sellerId: profile.userId, status: { in: [...openPreOrderStatuses] } },
            select: { id: true }
        })

        if (open) {
            throw new PreOrderRequestError(409, "You already have an open pre-order request with this shop", "PREORDER_EXISTS", { preOrderId: open.id })
        }

        const lines = await tx.cartItem.findMany({
            where: { cart: { userId: input.buyerId }, listing: { userId: profile.userId, archivedAt: null } },
            select: { listingId: true, quantity: true, listing: { select: { price: true, stockQuantity: true } } }
        })

        if (lines.length === 0) {
            throw new PreOrderRequestError(409, "Add something from this shop to your cart first", "PREORDER_CART_EMPTY")
        }

        if (lines.some((line) => line.quantity > line.listing.stockQuantity)) {
            throw new PreOrderRequestError(409, "Some of these are no longer available in this quantity", "PREORDER_CART_EMPTY")
        }

        const items: SnapshotItem[] = lines.map((line) => ({
            listingId: line.listingId,
            quantity: line.quantity,
            unitPrice: new Prisma.Decimal(line.listing.price.toString()).toDecimalPlaces(2).toFixed(2)
        }))

        return tx.preOrderRequest.create({
            data: {
                buyerId: input.buyerId,
                sellerId: profile.userId,
                readyAt: input.readyAt,
                note: input.note ?? null,
                items,
                respondBy: new Date(now.getTime() + sellerResponseHours * hourMs)
            }
        })
    }).then((request) => {
        queueNotification("pre-order requested", () => notifyPreOrderUpdate(request.id, "REQUESTED"))
        return request
    })
}

export async function cancelPreOrder(input: { id: number; buyerId: number }): Promise<PreOrderRequest> {
    const moved = await prisma.preOrderRequest.updateMany({
        where: { id: input.id, buyerId: input.buyerId, status: { in: [...openPreOrderStatuses] } },
        data: { status: "CANCELLED", decidedAt: new Date() }
    })

    if (moved.count !== 1) {
        const exists = await prisma.preOrderRequest.findFirst({ where: { id: input.id, buyerId: input.buyerId }, select: { id: true } })

        if (!exists) {
            throw new PreOrderRequestError(404, "Pre-order request not found")
        }

        throw new PreOrderRequestError(409, "This request can no longer be cancelled", "PREORDER_NOT_OPEN")
    }

    queueNotification("pre-order cancelled", () => notifyPreOrderUpdate(input.id, "CANCELLED"))
    return prisma.preOrderRequest.findUniqueOrThrow({ where: { id: input.id } })
}

// ---- the seller ----

export async function answerPreOrder(input: { id: number; sellerId: number; action: "APPROVE" | "DECLINE"; note: string | undefined }): Promise<PreOrderRequest> {
    const now = new Date()
    const request = await prisma.preOrderRequest.findFirst({ where: { id: input.id, sellerId: input.sellerId } })

    if (!request) {
        throw new PreOrderRequestError(404, "Pre-order request not found")
    }

    if (request.status !== "REQUESTED" || request.respondBy <= now) {
        throw new PreOrderRequestError(409, "This request is no longer waiting for your answer", "PREORDER_NOT_OPEN")
    }

    const approve = input.action === "APPROVE"

    if (approve && (await prisma.sellerProfile.count({ where: { userId: input.sellerId, blockedAt: { not: null } } })) > 0) {
        throw new PreOrderRequestError(409, "Your shop is blocked from new orders, so you cannot approve pre-orders. You can still decline.", "PREORDER_NOT_AVAILABLE")
    }

    if (approve && request.readyAt.getTime() < now.getTime() + approveMinimumNoticeHours * hourMs) {
        throw new PreOrderRequestError(409, "The time asked for is too close or has passed. Decline, and the buyer can ask for a later time.", "PREORDER_TIME_INVALID")
    }

    // The buyer pays within a day of approval, and never later than an hour before the food is wanted.
    const payBy = new Date(Math.min(now.getTime() + paymentHoursAfterApproval * hourMs, request.readyAt.getTime() - hourMs))
    const moved = await prisma.preOrderRequest.updateMany({
        where: { id: request.id, status: "REQUESTED", respondBy: { gt: now } },
        data: approve
            ? { status: "APPROVED", decidedAt: now, payBy, sellerNote: input.note ?? null }
            : { status: "DECLINED", decidedAt: now, sellerNote: input.note ?? null }
    })

    if (moved.count !== 1) {
        throw new PreOrderRequestError(409, "This request is no longer waiting for your answer", "PREORDER_NOT_OPEN")
    }

    queueNotification("pre-order answered", () => notifyPreOrderUpdate(request.id, approve ? "APPROVED" : "DECLINED"))
    return prisma.preOrderRequest.findUniqueOrThrow({ where: { id: request.id } })
}

// ---- background ----

// Lets requests lapse: a request the seller never answered, and an approval the buyer never paid for. Each is moved once.
export async function expirePreOrders(now = new Date()): Promise<number> {
    const due = await prisma.preOrderRequest.findMany({
        where: { OR: [{ status: "REQUESTED", respondBy: { lte: now } }, { status: "APPROVED", payBy: { lte: now } }] },
        select: { id: true, status: true },
        orderBy: { id: "asc" },
        take: 100
    })
    let expired = 0

    for (const request of due) {
        const moved = await prisma.preOrderRequest.updateMany({
            where: { id: request.id, status: request.status },
            data: { status: "EXPIRED", decidedAt: now }
        })

        if (moved.count === 1) {
            expired++
            queueNotification("pre-order expired", () => notifyPreOrderUpdate(request.id, request.status === "REQUESTED" ? "EXPIRED_UNANSWERED" : "EXPIRED_UNPAID"))
        }
    }

    return expired
}

// ---- views ----

type ViewRecord = PreOrderRequest & {
    seller: { sellerProfile: { businessName: string; slug: string } | null }
    buyer: { name: string }
}

export const preOrderViewInclude = {
    seller: { select: { sellerProfile: { select: { businessName: true, slug: true } } } },
    buyer: { select: { name: true } }
} satisfies Prisma.PreOrderRequestInclude

export async function toPreOrderViews(records: ViewRecord[], viewer: "BUYER" | "SELLER") {
    const listingIds = [...new Set(records.flatMap((record) => readItems(record.items).map((item) => item.listingId)))]
    const listings = await prisma.listing.findMany({ where: { id: { in: listingIds } }, select: { id: true, title: true } })
    const titles = new Map(listings.map((listing) => [listing.id, listing.title]))

    return records.map((record) => {
        const items = readItems(record.items).map((item) => ({
            listingId: item.listingId,
            title: titles.get(item.listingId) ?? "Item",
            quantity: item.quantity,
            unitPrice: item.unitPrice
        }))
        const subtotal = items.reduce((sum, item) => sum.plus(new Prisma.Decimal(item.unitPrice).times(item.quantity)), new Prisma.Decimal(0))

        return {
            id: record.id,
            status: record.status,
            readyAt: record.readyAt,
            note: record.note,
            sellerNote: record.sellerNote,
            respondBy: record.respondBy,
            payBy: record.payBy,
            decidedAt: record.decidedAt,
            createdAt: record.createdAt,
            items,
            subtotal: subtotal.toFixed(2),
            seller: record.seller.sellerProfile ? { businessName: record.seller.sellerProfile.businessName, slug: record.seller.sellerProfile.slug } : null,
            ...(viewer === "SELLER" ? { buyerName: record.buyer.name.trim().split(/\s+/)[0] ?? "A buyer" } : {})
        }
    })
}
