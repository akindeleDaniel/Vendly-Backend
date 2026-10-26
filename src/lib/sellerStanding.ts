import prisma from "./prisma.js"
import config from "../config.js"
import { Prisma } from "../generated/prisma/client.js"
import { openDebtBySeller, overDebtLimit } from "./orderLimits.js"
import { notifySellerBlocked, notifySellerUnblocked, notifySellerWarned, queueNotification } from "./notifications.js"

// A seller's standing. A complaint that ends in a refund against the seller is a strike, unless the seller agreed
// to the refund themselves. Strikes older than the window stop counting, and so do strikes from before an
// administrator last lifted a block.
export const strikeWindowDays = 90
export const strikesForWarning = 2
export const strikesForBlock = 4

const dayMs = 24 * 60 * 60 * 1000

export class SellerStandingError extends Error {
    status: number

    constructor(status: number, message: string) {
        super(message)
        this.status = status
    }
}

type Strike = { disputeId: number; orderId: number; reason: string; resolvedAt: Date }

async function loadStrikes(sellerId: number, now = new Date()): Promise<Strike[]> {
    const profile = await prisma.sellerProfile.findUnique({ where: { userId: sellerId }, select: { strikesResetAt: true } })
    const windowStart = new Date(now.getTime() - strikeWindowDays * dayMs)
    const since = profile?.strikesResetAt && profile.strikesResetAt > windowStart ? profile.strikesResetAt : windowStart

    const disputes = await prisma.dispute.findMany({
        where: {
            order: { sellerId },
            openedBy: "BUYER",
            status: "RESOLVED",
            outcome: "REFUNDED",
            sellerAgreedAt: null,
            resolvedAt: { gte: since }
        },
        orderBy: { resolvedAt: "desc" },
        select: { id: true, orderId: true, reason: true, resolvedAt: true }
    })

    return disputes.map((dispute) => ({ disputeId: dispute.id, orderId: dispute.orderId, reason: dispute.reason, resolvedAt: dispute.resolvedAt! }))
}

// What the seller (and an administrator) can see about the seller's standing.
export async function getSellerStanding(sellerId: number) {
    const profile = await prisma.sellerProfile.findUnique({
        where: { userId: sellerId },
        select: { blockedAt: true, blockReason: true, strikeWarnedAt: true }
    })

    if (!profile) {
        throw new SellerStandingError(404, "Seller not found")
    }

    const strikes = await loadStrikes(sellerId)
    const owed = (await openDebtBySeller(prisma, [sellerId])).get(sellerId)

    return {
        strikes: strikes.length,
        warnAt: strikesForWarning,
        blockAt: strikesForBlock,
        windowDays: strikeWindowDays,
        warned: profile.strikeWarnedAt !== null,
        blocked: profile.blockedAt !== null,
        blockedAt: profile.blockedAt,
        blockReason: profile.blockReason,
        // What the seller still owes for refunds, and whether that has paused new orders (the limit is in naira).
        debt: {
            amountOwed: (owed ?? new Prisma.Decimal(0)).toFixed(2),
            limit: config.sellerDebtLimit === null ? null : new Prisma.Decimal(config.sellerDebtLimit).toFixed(2),
            ordersPaused: overDebtLimit(owed)
        },
        recent: strikes
    }
}

// Run after a complaint against a seller ends in a refund. Warns at the first threshold and blocks at the second,
// once each; it never lifts a block.
export async function reviewSellerStanding(sellerId: number): Promise<void> {
    const profile = await prisma.sellerProfile.findUnique({ where: { userId: sellerId }, select: { blockedAt: true, strikeWarnedAt: true } })

    if (!profile || profile.blockedAt) {
        return
    }

    const strikes = (await loadStrikes(sellerId)).length

    if (strikes >= strikesForBlock) {
        const blocked = await prisma.sellerProfile.updateMany({
            where: { userId: sellerId, blockedAt: null },
            data: { blockedAt: new Date(), blockReason: `Automatic: ${strikes} lost complaints in ${strikeWindowDays} days` }
        })

        if (blocked.count === 1) {
            queueNotification("seller blocked", () => notifySellerBlocked(sellerId))
        }
        return
    }

    if (strikes >= strikesForWarning && !profile.strikeWarnedAt) {
        const warned = await prisma.sellerProfile.updateMany({ where: { userId: sellerId, strikeWarnedAt: null }, data: { strikeWarnedAt: new Date() } })

        if (warned.count === 1) {
            queueNotification("seller warned", () => notifySellerWarned(sellerId, strikes))
        }
    }
}

// An administrator blocks a shop by hand, for any reason they write down.
export async function blockSeller(sellerId: number, note: string): Promise<void> {
    const blocked = await prisma.sellerProfile.updateMany({ where: { userId: sellerId, blockedAt: null }, data: { blockedAt: new Date(), blockReason: note } })

    if (blocked.count === 1) {
        queueNotification("seller blocked", () => notifySellerBlocked(sellerId))
        return
    }

    const exists = await prisma.sellerProfile.findUnique({ where: { userId: sellerId }, select: { id: true } })
    throw exists ? new SellerStandingError(409, "This seller is already blocked") : new SellerStandingError(404, "Seller not found")
}

// Lifting a block also starts the strike count again, so the same complaints do not block the shop straight away.
export async function unblockSeller(sellerId: number): Promise<void> {
    const now = new Date()
    const lifted = await prisma.sellerProfile.updateMany({
        where: { userId: sellerId, blockedAt: { not: null } },
        data: { blockedAt: null, blockReason: null, strikeWarnedAt: null, strikesResetAt: now }
    })

    if (lifted.count === 1) {
        queueNotification("seller unblocked", () => notifySellerUnblocked(sellerId))
        return
    }

    const exists = await prisma.sellerProfile.findUnique({ where: { userId: sellerId }, select: { id: true } })
    throw exists ? new SellerStandingError(409, "This seller is not blocked") : new SellerStandingError(404, "Seller not found")
}
