import prisma from "./prisma.js"
import { Prisma } from "../generated/prisma/client.js"

// Public trust numbers, worked out by the server from real orders so a seller cannot type them in or inflate them.
// What shoppers said would give them most confidence was knowing that earlier buyers really received their orders,
// so the headline number counts only deliveries the BUYER confirmed (not ones closed automatically after 7 days),
// and leaves out orders that were refunded afterwards.

export type ShopTrust = {
    // Orders whose buyer confirmed delivery and that were not refunded.
    confirmedDeliveries: number
    // Complaints opened by buyers that are finished (decided or withdrawn), and ones still open.
    complaintsSettled: number
    complaintsOpen: number
    // The seller's bank account was checked with the payment provider and is ready to receive payments.
    payoutVerified: boolean
    // When the seller's account was created.
    sellingSince: Date | null
}

const emptyTrust = (): ShopTrust => ({ confirmedDeliveries: 0, complaintsSettled: 0, complaintsOpen: 0, payoutVerified: false, sellingSince: null })

export async function shopTrustFor(sellerIds: number[]): Promise<Map<number, ShopTrust>> {
    const result = new Map<number, ShopTrust>()
    const ids = [...new Set(sellerIds)]

    if (ids.length === 0) {
        return result
    }

    for (const id of ids) {
        result.set(id, emptyTrust())
    }

    const [deliveries, complaints, sellers] = await Promise.all([
        prisma.order.groupBy({
            by: ["sellerId"],
            where: { sellerId: { in: ids }, status: "DELIVERED", deliveryConfirmedAt: { not: null } },
            _count: { _all: true }
        }),
        prisma.$queryRaw<Array<{ sellerId: number; settled: bigint; open: bigint }>>`
            SELECT o."sellerId" AS "sellerId",
                   count(*) FILTER (WHERE d.status::text IN ('RESOLVED', 'WITHDRAWN')) AS settled,
                   count(*) FILTER (WHERE d.status::text IN ('OPEN', 'SELLER_AGREED', 'UNDER_REVIEW')) AS open
            FROM "Dispute" d
            JOIN "Order" o ON o.id = d."orderId"
            WHERE d."openedBy"::text = 'BUYER' AND o."sellerId" IN (${Prisma.join(ids)})
            GROUP BY o."sellerId"`,
        prisma.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, createdAt: true, sellerProfile: { select: { payoutAccounts: { where: { status: "ACTIVE" }, select: { id: true }, take: 1 } } } }
        })
    ])

    for (const row of deliveries) {
        result.get(row.sellerId)!.confirmedDeliveries = row._count._all
    }

    for (const row of complaints) {
        const trust = result.get(row.sellerId)!
        trust.complaintsSettled = Number(row.settled)
        trust.complaintsOpen = Number(row.open)
    }

    for (const seller of sellers) {
        const trust = result.get(seller.id)!
        trust.sellingSince = seller.createdAt
        trust.payoutVerified = (seller.sellerProfile?.payoutAccounts.length ?? 0) > 0
    }

    return result
}

// For each product (a listing, counting all of its options together), how many buyer-confirmed, unrefunded orders
// contained it.
export async function confirmedDeliveriesFor(listingIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>()
    const ids = [...new Set(listingIds)]

    if (ids.length === 0) {
        return result
    }

    const rows = await prisma.$queryRaw<Array<{ productId: number; orders: bigint }>>`
        SELECT coalesce(l."parentId", l.id) AS "productId", count(DISTINCT oi."orderId") AS orders
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        JOIN "Listing" l ON l.id = oi."listingId"
        WHERE o.status::text = 'DELIVERED'
          AND o."deliveryConfirmedAt" IS NOT NULL
          AND coalesce(l."parentId", l.id) IN (${Prisma.join(ids)})
        GROUP BY 1`

    for (const row of rows) {
        result.set(row.productId, Number(row.orders))
    }

    return result
}
