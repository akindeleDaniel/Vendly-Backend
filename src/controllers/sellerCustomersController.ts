import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma } from "../generated/prisma/client.js"
import { reviewerLabel } from "../lib/reviews.js"

// A seller's own customers: everyone who has paid for an order from this shop. It is built from the seller's orders
// only, so a seller never learns anything about a buyer's other shopping. Buyers are named the way reviews name them
// (first name and the first letter of the last name), with no email, phone number or address: those stay on each
// order's page, where the seller needs them to deliver.
const customersPageSize = 20

const sorts = {
    recent: Prisma.sql`"lastOrderAt" DESC`,
    orders: Prisma.sql`orders DESC, "lastOrderAt" DESC`,
    spent: Prisma.sql`spent DESC, "lastOrderAt" DESC`
} as const

type CustomerSort = keyof typeof sorts

function money(amount: Prisma.Decimal | number | null | undefined): string {
    return new Prisma.Decimal(amount ?? 0).toFixed(2)
}

export const listMyCustomers = async (req: Request, res: Response) => {
    const sellerId = req.user!.id
    const pageValue = req.query.page === undefined ? 1 : Number(req.query.page)
    const sort = req.query.sort === undefined ? "recent" : (Object.keys(sorts) as CustomerSort[]).find((candidate) => candidate === req.query.sort) ?? null

    if (!Number.isSafeInteger(pageValue) || pageValue < 1) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    if (sort === null) {
        res.status(400).send({ message: "Sort must be recent, orders or spent" })
        return
    }

    const paidOrders = Prisma.sql`
        FROM "Order" o JOIN "Checkout" c ON c.id = o."checkoutId"
        WHERE o."sellerId" = ${sellerId} AND o.status::text IN ('PAID', 'SHIPPED', 'DELIVERED', 'REFUNDED')`
    const [rows, totals] = await Promise.all([
        prisma.$queryRaw<Array<{ userId: number; orders: bigint; spent: Prisma.Decimal; refunded: Prisma.Decimal; firstOrderAt: Date; lastOrderAt: Date }>>`
            SELECT c."userId" AS "userId", count(*) AS orders, sum(o.total) AS spent, sum(o."refundedAmount") AS refunded,
                   min(o."createdAt") AS "firstOrderAt", max(o."createdAt") AS "lastOrderAt"
            ${paidOrders}
            GROUP BY c."userId"
            ORDER BY ${sorts[sort]}, c."userId"
            LIMIT ${customersPageSize} OFFSET ${(pageValue - 1) * customersPageSize}`,
        prisma.$queryRaw<Array<{ customers: bigint; repeat: bigint }>>`
            SELECT count(*) AS customers, count(*) FILTER (WHERE orders > 1) AS repeat
            FROM (SELECT c."userId", count(*) AS orders ${paidOrders} GROUP BY c."userId") AS per_customer`
    ])
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((row) => row.userId) } }, select: { id: true, name: true } })
    const names = new Map(users.map((user) => [user.id, user.name]))
    const customers = Number(totals[0]?.customers ?? 0)

    res.send({
        page: pageValue,
        pageSize: customersPageSize,
        total: customers,
        counts: { customers, repeatCustomers: Number(totals[0]?.repeat ?? 0) },
        customers: rows.map((row) => ({
            name: reviewerLabel(names.get(row.userId) ?? "A buyer"),
            orders: Number(row.orders),
            // What they paid this shop, and how much of it was refunded.
            spent: money(row.spent),
            refunded: money(row.refunded),
            firstOrderAt: row.firstOrderAt,
            lastOrderAt: row.lastOrderAt,
            repeat: Number(row.orders) > 1
        }))
    })
}
