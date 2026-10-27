import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma, type OrderStatus } from "../generated/prisma/client.js"

// A seller's own sales figures. The split happens when a customer pays, so the money reaches the seller's bank
// through the payment provider on the provider's schedule; these figures come from what the provider reported
// for each order, so they are a record of the sales, not a bank statement.

// Orders that were actually paid. Pending and cancelled orders never count.
const paidStatuses: OrderStatus[] = ["PAID", "SHIPPED", "DELIVERED", "REFUNDED"]
const monthsShown = 12

function money(amount: Prisma.Decimal | number | null | undefined): string {
    return new Prisma.Decimal(amount ?? 0).toFixed(2)
}

// A date as YYYY-MM-DD (UTC). Undefined when absent, null when invalid.
function parseDate(value: unknown): Date | undefined | null {
    if (value === undefined) {
        return undefined
    }

    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return null
    }

    const date = new Date(`${value}T00:00:00.000Z`)
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date
}

export const getMyEarnings = async (req: Request, res: Response) => {
    const sellerId = req.user!.id
    const from = parseDate(req.query.from)
    const to = parseDate(req.query.to)

    if (from === null || to === null) {
        res.status(400).send({ message: "Dates must be written as YYYY-MM-DD" })
        return
    }

    if (from && to && from > to) {
        res.status(400).send({ message: "The start date must not be after the end date" })
        return
    }

    // "to" is a whole day, so the range ends at the start of the next day.
    const until = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000) : undefined
    const where: Prisma.OrderWhereInput = {
        sellerId,
        status: { in: paidStatuses },
        ...(from || until ? { createdAt: { ...(from ? { gte: from } : {}), ...(until ? { lt: until } : {}) } } : {})
    }
    const monthsStart = new Date()
    monthsStart.setUTCDate(1)
    monthsStart.setUTCHours(0, 0, 0, 0)
    monthsStart.setUTCMonth(monthsStart.getUTCMonth() - (monthsShown - 1))

    const [totals, byStatus, unreported, openLiabilities, months] = await Promise.all([
        prisma.order.aggregate({
            where,
            _count: { _all: true },
            _sum: { total: true, providerFee: true, sellerReceives: true, refundedAmount: true, liabilityDeduction: true }
        }),
        prisma.order.groupBy({ by: ["status"], where, _count: { _all: true } }),
        // Orders whose provider figures were not reported, so the fee and payout totals leave them out.
        prisma.order.count({ where: { ...where, sellerReceives: null } }),
        prisma.sellerLiability.aggregate({ where: { sellerId, status: "OPEN" }, _count: { _all: true }, _sum: { amount: true, recovered: true } }),
        prisma.$queryRaw<Array<{ month: string; orders: bigint; sales: Prisma.Decimal; fees: Prisma.Decimal; received: Prisma.Decimal; refunded: Prisma.Decimal }>>`
            SELECT to_char(date_trunc('month', o."createdAt"), 'YYYY-MM') AS month,
                   count(*) AS orders,
                   sum(o.total) AS sales,
                   sum(coalesce(o."providerFee", 0)) AS fees,
                   sum(coalesce(o."sellerReceives", 0)) AS received,
                   sum(o."refundedAmount") AS refunded
            FROM "Order" o
            WHERE o."sellerId" = ${sellerId}
              AND o.status::text IN ('PAID', 'SHIPPED', 'DELIVERED', 'REFUNDED')
              AND o."createdAt" >= ${monthsStart}
            GROUP BY 1
            ORDER BY 1 DESC`
    ])
    const sum = totals._sum
    const stillOwed = new Prisma.Decimal(openLiabilities._sum.amount ?? 0).minus(openLiabilities._sum.recovered ?? 0)

    res.send({
        from: from ? from.toISOString().slice(0, 10) : null,
        to: to ? to.toISOString().slice(0, 10) : null,
        totals: {
            orders: totals._count._all,
            sales: money(sum.total),
            providerFees: money(sum.providerFee),
            paidOutByProvider: money(sum.sellerReceives),
            refunded: money(sum.refundedAmount),
            keptForEarlierRefunds: money(sum.liabilityDeduction),
            ordersWithoutProviderFigures: unreported
        },
        ordersByStatus: Object.fromEntries(byStatus.map((group) => [group.status, group._count._all])),
        owedToVendly: { count: openLiabilities._count._all, amountStillOwed: money(stillOwed) },
        // The last twelve months, newest first, whatever the date range above (months with no sales are left out).
        months: months.map((row) => ({
            month: row.month,
            orders: Number(row.orders),
            sales: money(row.sales),
            providerFees: money(row.fees),
            paidOutByProvider: money(row.received),
            refunded: money(row.refunded)
        }))
    })
}

// ---- The sales summary: how the shop is doing over a period, at a glance ----

const dayMs = 24 * 60 * 60 * 1000
const defaultSummaryDays = 30
const maximumSummaryDays = 366
const topProductsShown = 5

// Today's date in Nigeria (UTC+1 all year), as YYYY-MM-DD.
function lagosToday(now = new Date()): string {
    return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10)
}

// The moment a Nigerian calendar day starts.
function lagosDayStart(day: string): Date {
    return new Date(`${day}T00:00:00.000+01:00`)
}

function addDays(day: string, days: number): string {
    return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + days * dayMs).toISOString().slice(0, 10)
}

async function periodTotals(sellerId: number, start: Date, end: Date) {
    const where: Prisma.OrderWhereInput = { sellerId, status: { in: paidStatuses }, createdAt: { gte: start, lt: end } }
    const [orders, items, customers] = await Promise.all([
        prisma.order.aggregate({ where, _count: { _all: true }, _sum: { total: true, refundedAmount: true } }),
        prisma.orderItem.aggregate({ where: { order: where }, _sum: { quantity: true } }),
        prisma.$queryRaw<Array<{ customers: bigint }>>`
            SELECT count(DISTINCT c."userId") AS customers
            FROM "Order" o JOIN "Checkout" c ON c.id = o."checkoutId"
            WHERE o."sellerId" = ${sellerId}
              AND o.status::text IN ('PAID', 'SHIPPED', 'DELIVERED', 'REFUNDED')
              AND o."createdAt" >= ${start} AND o."createdAt" < ${end}`
    ])
    const sales = new Prisma.Decimal(orders._sum.total ?? 0)
    const refunded = new Prisma.Decimal(orders._sum.refundedAmount ?? 0)
    const count = orders._count._all

    return {
        orders: count,
        sales: money(sales),
        refunded: money(refunded),
        // What the shop kept from its sales once refunds are taken off.
        netSales: money(sales.minus(refunded)),
        itemsSold: items._sum.quantity ?? 0,
        customers: Number(customers[0]?.customers ?? 0),
        averageOrder: count === 0 ? null : money(sales.dividedBy(count))
    }
}

// GET /seller/summary?from=YYYY-MM-DD&to=YYYY-MM-DD. Days are Nigerian calendar days; the default is the last 30
// days up to today. Alongside the period's figures: the same figures for the period just before (to show up or
// down), the best-selling products, sales for each day, and what needs the seller's attention now.
export const getMySalesSummary = async (req: Request, res: Response) => {
    const sellerId = req.user!.id
    const fromDate = parseDate(req.query.from)
    const toDate = parseDate(req.query.to)

    if (fromDate === null || toDate === null) {
        res.status(400).send({ message: "Dates must be written as YYYY-MM-DD" })
        return
    }

    const to = toDate ? toDate.toISOString().slice(0, 10) : lagosToday()
    const from = fromDate ? fromDate.toISOString().slice(0, 10) : addDays(to, -(defaultSummaryDays - 1))

    if (from > to) {
        res.status(400).send({ message: "The start date must not be after the end date" })
        return
    }

    const days = Math.round((Date.parse(to) - Date.parse(from)) / dayMs) + 1

    if (days > maximumSummaryDays) {
        res.status(400).send({ message: `Choose a period of at most ${maximumSummaryDays} days` })
        return
    }

    const start = lagosDayStart(from)
    const end = lagosDayStart(addDays(to, 1))
    const previousStart = lagosDayStart(addDays(from, -days))
    const now = new Date()

    const [current, previous, top, daily, toShip, awaitingConfirmation, complaintsToAnswer, openComplaints, preOrdersToAnswer] = await Promise.all([
        periodTotals(sellerId, start, end),
        periodTotals(sellerId, previousStart, start),
        // An option's sales count towards its product.
        prisma.$queryRaw<Array<{ productId: number; quantity: bigint; sales: Prisma.Decimal }>>`
            SELECT coalesce(l."parentId", l.id) AS "productId", sum(oi.quantity) AS quantity, sum(oi."unitPrice" * oi.quantity) AS sales
            FROM "OrderItem" oi
            JOIN "Order" o ON o.id = oi."orderId"
            JOIN "Listing" l ON l.id = oi."listingId"
            WHERE o."sellerId" = ${sellerId}
              AND o.status::text IN ('PAID', 'SHIPPED', 'DELIVERED', 'REFUNDED')
              AND o."createdAt" >= ${start} AND o."createdAt" < ${end}
            GROUP BY 1
            ORDER BY quantity DESC, sales DESC, 1
            LIMIT ${topProductsShown}`,
        prisma.$queryRaw<Array<{ day: string; orders: bigint; sales: Prisma.Decimal }>>`
            SELECT to_char((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS day,
                   count(*) AS orders, sum(o.total) AS sales
            FROM "Order" o
            WHERE o."sellerId" = ${sellerId}
              AND o.status::text IN ('PAID', 'SHIPPED', 'DELIVERED', 'REFUNDED')
              AND o."createdAt" >= ${start} AND o."createdAt" < ${end}
            GROUP BY 1`,
        prisma.order.count({ where: { sellerId, status: "PAID" } }),
        prisma.order.count({ where: { sellerId, status: "SHIPPED", deliveryReportedAt: { not: null } } }),
        prisma.dispute.count({ where: { order: { sellerId }, status: "OPEN", sellerRespondedAt: null } }),
        prisma.dispute.count({ where: { order: { sellerId }, status: { in: ["OPEN", "SELLER_AGREED", "UNDER_REVIEW"] } } }),
        prisma.preOrderRequest.count({ where: { sellerId, status: "REQUESTED", respondBy: { gt: now } } })
    ])
    const products = await prisma.listing.findMany({
        where: { id: { in: top.map((row) => row.productId) } },
        select: { id: true, title: true, imageUrl: true, archivedAt: true }
    })
    const byDay = new Map(daily.map((row) => [row.day, row]))

    res.send({
        from,
        to,
        totals: current,
        // The same figures for the period of the same length just before this one.
        previous: { from: addDays(from, -days), to: addDays(from, -1), ...previous },
        topProducts: top.map((row) => {
            const product = products.find((candidate) => candidate.id === row.productId)
            return {
                listingId: row.productId,
                title: product?.title ?? "Product",
                imageUrl: product?.imageUrl || null,
                onSale: product ? product.archivedAt === null : false,
                quantity: Number(row.quantity),
                sales: money(row.sales)
            }
        }),
        // Every day of the period, including days without sales.
        days: Array.from({ length: days }, (_, index) => {
            const day = addDays(from, index)
            const row = byDay.get(day)
            return { date: day, orders: Number(row?.orders ?? 0), sales: money(row?.sales ?? 0) }
        }),
        // Right now, whatever the period.
        needsAttention: { ordersToShip: toShip, awaitingBuyerConfirmation: awaitingConfirmation, complaintsToAnswer, openComplaints, preOrdersToAnswer }
    })
}
