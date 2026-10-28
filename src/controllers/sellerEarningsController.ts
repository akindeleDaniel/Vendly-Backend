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

    // Days and months are Nigerian ones, as in the sales summary. "to" is a whole day, so the range ends when the next
    // Nigerian day starts.
    const fromDay = from ? from.toISOString().slice(0, 10) : null
    const toDay = to ? to.toISOString().slice(0, 10) : null
    const since = fromDay ? lagosDayStart(fromDay) : undefined
    const until = toDay ? lagosDayStart(addDays(toDay, 1)) : undefined
    const where: Prisma.OrderWhereInput = {
        sellerId,
        status: { in: paidStatuses },
        ...(since || until ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lt: until } : {}) } } : {})
    }
    const thisMonth = new Date(`${lagosToday().slice(0, 7)}-01T00:00:00.000Z`)
    thisMonth.setUTCMonth(thisMonth.getUTCMonth() - (monthsShown - 1))
    const monthsStart = lagosDayStart(thisMonth.toISOString().slice(0, 10))

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
            SELECT to_char(date_trunc('month', (o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos'), 'YYYY-MM') AS month,
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
        from: fromDay,
        to: toDay,
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

export type LagosPeriod = { from: string; to: string; days: number; start: Date; end: Date }

// Reads ?from=&to= as Nigerian calendar days (default: the last 30 days up to today, at most 366 days).
export function readLagosPeriod(query: { from?: unknown; to?: unknown }): LagosPeriod | { error: string } {
    const fromDate = parseDate(query.from)
    const toDate = parseDate(query.to)

    if (fromDate === null || toDate === null) {
        return { error: "Dates must be written as YYYY-MM-DD" }
    }

    const to = toDate ? toDate.toISOString().slice(0, 10) : lagosToday()
    const from = fromDate ? fromDate.toISOString().slice(0, 10) : addDays(to, -(defaultSummaryDays - 1))

    if (from > to) {
        return { error: "The start date must not be after the end date" }
    }

    const days = Math.round((Date.parse(to) - Date.parse(from)) / dayMs) + 1

    if (days > maximumSummaryDays) {
        return { error: `Choose a period of at most ${maximumSummaryDays} days` }
    }

    return { from, to, days, start: lagosDayStart(from), end: lagosDayStart(addDays(to, 1)) }
}

// A Nigerian calendar day as the date stored for view counts.
const dateOnly = (day: string) => new Date(`${day}T00:00:00.000Z`)

// Shop and product views over Nigerian days fromDay to toDay.
async function viewTotals(sellerId: number, fromDay: string, toDay: string) {
    const groups = await prisma.viewDay.groupBy({
        by: ["kind"],
        where: { sellerId, day: { gte: dateOnly(fromDay), lte: dateOnly(toDay) } },
        _sum: { views: true }
    })
    const shop = groups.find((group) => group.kind === "SHOP")?._sum.views ?? 0
    const products = groups.find((group) => group.kind === "PRODUCT")?._sum.views ?? 0
    return { shop, products, total: shop + products }
}

// Orders that included it, out of every 100 product views. Null without views.
function conversion(orders: number, views: number): number | null {
    return views === 0 ? null : Math.round((orders / views) * 1000) / 10
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
    const period = readLagosPeriod(req.query)

    if ("error" in period) {
        res.status(400).send({ message: period.error })
        return
    }

    const { from, to, days, start, end } = period
    const previousStart = lagosDayStart(addDays(from, -days))
    const now = new Date()

    const viewsWhere = { sellerId, day: { gte: dateOnly(from), lte: dateOnly(to) } }
    const [current, previous, currentViews, previousViews, viewsPerDay, viewsPerProduct, top, daily, toShip, awaitingConfirmation, complaintsToAnswer, openComplaints, preOrdersToAnswer] = await Promise.all([
        periodTotals(sellerId, start, end),
        periodTotals(sellerId, previousStart, start),
        viewTotals(sellerId, from, to),
        viewTotals(sellerId, addDays(from, -days), addDays(from, -1)),
        prisma.viewDay.groupBy({ by: ["day"], where: viewsWhere, _sum: { views: true } }),
        prisma.viewDay.groupBy({ by: ["subjectId"], where: { ...viewsWhere, kind: "PRODUCT" }, _sum: { views: true } }),
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
    const productViews = new Map(viewsPerProduct.map((group) => [group.subjectId, group._sum.views ?? 0]))
    const dayViews = new Map(viewsPerDay.map((group) => [group.day.toISOString().slice(0, 10), group._sum.views ?? 0]))
    // The products people looked at most, with how many orders included them (an option's orders count for its product).
    const mostViewedIds = [...productViews.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]).slice(0, topProductsShown).map(([id]) => id)
    const viewedOrders = mostViewedIds.length === 0 ? [] : await prisma.$queryRaw<Array<{ productId: number; orders: bigint }>>`
        SELECT coalesce(l."parentId", l.id) AS "productId", count(DISTINCT o.id) AS orders
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        JOIN "Listing" l ON l.id = oi."listingId"
        WHERE o."sellerId" = ${sellerId}
          AND o.status::text IN ('PAID', 'SHIPPED', 'DELIVERED', 'REFUNDED')
          AND o."createdAt" >= ${start} AND o."createdAt" < ${end}
          AND coalesce(l."parentId", l.id) IN (${Prisma.join(mostViewedIds)})
        GROUP BY 1`
    const ordersOf = new Map(viewedOrders.map((row) => [row.productId, Number(row.orders)]))
    const products = await prisma.listing.findMany({
        where: { id: { in: [...new Set([...top.map((row) => row.productId), ...mostViewedIds])] } },
        select: { id: true, title: true, imageUrl: true, archivedAt: true }
    })
    const byDay = new Map(daily.map((row) => [row.day, row]))

    res.send({
        from,
        to,
        totals: { ...current, views: currentViews },
        // The same figures for the period of the same length just before this one.
        previous: { from: addDays(from, -days), to: addDays(from, -1), ...previous, views: previousViews },
        topProducts: top.map((row) => {
            const product = products.find((candidate) => candidate.id === row.productId)
            return {
                listingId: row.productId,
                title: product?.title ?? "Product",
                imageUrl: product?.imageUrl || null,
                onSale: product ? product.archivedAt === null : false,
                quantity: Number(row.quantity),
                sales: money(row.sales),
                views: productViews.get(row.productId) ?? 0
            }
        }),
        mostViewed: mostViewedIds.map((id) => {
            const product = products.find((candidate) => candidate.id === id)
            const views = productViews.get(id) ?? 0
            const orders = ordersOf.get(id) ?? 0
            return {
                listingId: id,
                title: product?.title ?? "Product",
                imageUrl: product?.imageUrl || null,
                onSale: product ? product.archivedAt === null : false,
                views,
                orders,
                conversionRate: conversion(orders, views)
            }
        }),
        // Every day of the period, including days without sales.
        days: Array.from({ length: days }, (_, index) => {
            const day = addDays(from, index)
            const row = byDay.get(day)
            return { date: day, orders: Number(row?.orders ?? 0), sales: money(row?.sales ?? 0), views: dayViews.get(day) ?? 0 }
        }),
        // Right now, whatever the period.
        needsAttention: { ordersToShip: toShip, awaitingBuyerConfirmation: awaitingConfirmation, complaintsToAnswer, openComplaints, preOrdersToAnswer }
    })
}
