import prisma from "./prisma.js"

// Which complaints have messages the buyer or seller has not seen yet. A message counts as new when someone
// other than the viewer wrote it after the viewer last opened the complaint (or the viewer never opened it).
// The viewer's own messages, and a complaint they withdrew, never count.

export type ReadingParty = "BUYER" | "SELLER"

export async function countUnreadDisputes(viewer: ReadingParty, userId: number): Promise<number> {
    const rows = viewer === "BUYER"
        ? await prisma.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*) AS count
            FROM "Dispute" d
            JOIN "Order" o ON o.id = d."orderId"
            JOIN "Checkout" c ON c.id = o."checkoutId"
            WHERE c."userId" = ${userId}
              AND d.status::text <> 'WITHDRAWN'
              AND EXISTS (
                SELECT 1 FROM "DisputeMessage" m
                WHERE m."disputeId" = d.id AND m.author::text <> 'BUYER'
                  AND (d."buyerReadAt" IS NULL OR m."createdAt" > d."buyerReadAt")
              )`
        : await prisma.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*) AS count
            FROM "Dispute" d
            JOIN "Order" o ON o.id = d."orderId"
            WHERE o."sellerId" = ${userId}
              AND d.status::text <> 'WITHDRAWN'
              AND EXISTS (
                SELECT 1 FROM "DisputeMessage" m
                WHERE m."disputeId" = d.id AND m.author::text <> 'SELLER'
                  AND (d."sellerReadAt" IS NULL OR m."createdAt" > d."sellerReadAt")
              )`

    return Number(rows[0]?.count ?? 0)
}

// Of the given complaints, the ids with something new for this viewer.
export async function unreadDisputeIds(viewer: ReadingParty, userId: number, disputeIds: number[]): Promise<Set<number>> {
    if (disputeIds.length === 0) {
        return new Set()
    }

    const rows = viewer === "BUYER"
        ? await prisma.$queryRaw<Array<{ id: number }>>`
            SELECT d.id
            FROM "Dispute" d
            JOIN "Order" o ON o.id = d."orderId"
            JOIN "Checkout" c ON c.id = o."checkoutId"
            WHERE c."userId" = ${userId} AND d.id = ANY(${disputeIds}::int[])
              AND EXISTS (
                SELECT 1 FROM "DisputeMessage" m
                WHERE m."disputeId" = d.id AND m.author::text <> 'BUYER'
                  AND (d."buyerReadAt" IS NULL OR m."createdAt" > d."buyerReadAt")
              )`
        : await prisma.$queryRaw<Array<{ id: number }>>`
            SELECT d.id
            FROM "Dispute" d
            JOIN "Order" o ON o.id = d."orderId"
            WHERE o."sellerId" = ${userId} AND d.id = ANY(${disputeIds}::int[])
              AND EXISTS (
                SELECT 1 FROM "DisputeMessage" m
                WHERE m."disputeId" = d.id AND m.author::text <> 'SELLER'
                  AND (d."sellerReadAt" IS NULL OR m."createdAt" > d."sellerReadAt")
              )`

    return new Set(rows.map((row) => row.id))
}

// Records that the viewer has seen the complaint up to `seenAt`. Call it with a time taken before the complaint
// was loaded, so a message that arrives while loading is still shown as new. It only ever moves forward.
export async function markDisputeRead(viewer: ReadingParty, disputeId: number, seenAt: Date): Promise<void> {
    if (viewer === "BUYER") {
        await prisma.dispute.updateMany({
            where: { id: disputeId, OR: [{ buyerReadAt: null }, { buyerReadAt: { lt: seenAt } }] },
            data: { buyerReadAt: seenAt }
        })
    } else {
        await prisma.dispute.updateMany({
            where: { id: disputeId, OR: [{ sellerReadAt: null }, { sellerReadAt: { lt: seenAt } }] },
            data: { sellerReadAt: seenAt }
        })
    }
}
