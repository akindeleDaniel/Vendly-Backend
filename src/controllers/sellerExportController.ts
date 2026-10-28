import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import type { OrderStatus, Prisma } from "../generated/prisma/client.js"
import { readLagosPeriod } from "./sellerEarningsController.js"
import { csvCell } from "../lib/csv.js"

// The seller's orders as a spreadsheet (CSV, which Excel and Google Sheets open), for their own records, accounts or
// a bookkeeper. Only paid orders, one row per order. Buyers are named by first name and state only: their phone
// number and address stay on each order's page.
const exportedStatuses: OrderStatus[] = ["PAID", "SHIPPED", "DELIVERED", "REFUNDED"]
const maximumRows = 20000

const statusLabels: Record<string, string> = { PAID: "Paid, to ship", SHIPPED: "Shipped", DELIVERED: "Delivered", REFUNDED: "Refunded" }

function money(amount: Prisma.Decimal | null): string {
    return amount === null ? "" : amount.toFixed(2)
}

// The date and time in Nigeria, as 2026-10-28 14:05.
function lagosDateTime(date: Date | null): string {
    return date ? new Date(date.getTime() + 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ") : ""
}

export const exportMyOrders = async (req: Request, res: Response) => {
    const period = readLagosPeriod(req.query)

    if ("error" in period) {
        res.status(400).send({ message: period.error })
        return
    }

    const orders = await prisma.order.findMany({
        where: { sellerId: req.user!.id, status: { in: exportedStatuses }, createdAt: { gte: period.start, lt: period.end } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: maximumRows,
        select: {
            id: true,
            createdAt: true,
            status: true,
            fulfilmentType: true,
            readyAt: true,
            subtotal: true,
            shippingCost: true,
            total: true,
            refundedAmount: true,
            providerFee: true,
            sellerReceives: true,
            liabilityDeduction: true,
            deliveryName: true,
            deliveryState: true,
            deliveryLga: true,
            shippedAt: true,
            deliveryConfirmedAt: true,
            deliveryAutoClosedAt: true,
            orderItems: { orderBy: { id: "asc" }, select: { title: true, quantity: true, unitPrice: true } }
        }
    })

    const header = [
        "Order", "Date", "Status", "Type", "Ready at", "Items", "Item count", "Subtotal", "Delivery", "Total", "Refunded",
        "Net after refunds", "Provider fee", "You received", "Kept for earlier refunds", "Buyer", "State", "LGA", "Shipped", "Delivered"
    ]
    const rows = orders.map((order) => [
        order.id,
        lagosDateTime(order.createdAt),
        statusLabels[order.status] ?? order.status,
        order.fulfilmentType === "PRE_ORDER" ? "Pre-order" : "Order",
        lagosDateTime(order.readyAt),
        order.orderItems.map((item) => `${item.quantity} x ${item.title} @ ${item.unitPrice.toFixed(2)}`).join("; "),
        order.orderItems.reduce((count, item) => count + item.quantity, 0),
        money(order.subtotal),
        money(order.shippingCost),
        money(order.total),
        money(order.refundedAmount),
        money(order.total.minus(order.refundedAmount)),
        money(order.providerFee),
        money(order.sellerReceives),
        money(order.liabilityDeduction),
        order.deliveryName.trim().split(/\s+/)[0] ?? "",
        order.deliveryState,
        order.deliveryLga,
        lagosDateTime(order.shippedAt),
        lagosDateTime(order.deliveryConfirmedAt ?? order.deliveryAutoClosedAt)
    ])
    // The byte-order mark makes Excel read the file as UTF-8, so names with accents and the naira sign show properly.
    const csv = "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n"

    res.set("Cache-Control", "no-store")
        .attachment(`storehatch-orders-${period.from}-to-${period.to}.csv`)
        .type("text/csv; charset=utf-8")
        .send(csv)
}
