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
