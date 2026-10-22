import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import type { OrderStatus, Prisma } from "../generated/prisma/client.js"
import { notifyDeliveryConfirmed, notifyDeliveryReported, notifyShipped, queueNotification } from "../lib/notifications.js"

const pageSize = 20
const maximumShippingNoteLength = 200
// Sellers only see orders that have been paid; unpaid and cancelled checkouts are not theirs to act on.
const sellerVisibleStatuses: OrderStatus[] = ["PAID", "SHIPPED", "DELIVERED", "REFUNDED"]

function money(amount: Prisma.Decimal | null): string | null {
    return amount === null ? null : amount.toFixed(2)
}

// Each line's price as saved at checkout, with the line total (unit price × quantity).
function toItemResponse(item: { listingId: number; title: string; unitPrice: Prisma.Decimal; quantity: number }) {
    return {
        listingId: item.listingId,
        title: item.title,
        quantity: item.quantity,
        unitPrice: money(item.unitPrice),
        lineTotal: money(item.unitPrice.times(item.quantity))
    }
}

// The buyer's delivery address as saved on a seller order.
function toDeliveryResponse(order: { deliveryName: string; deliveryPhone: string; deliveryAddress: string; deliveryState: string; deliveryLga: string; deliveryInstructions: string | null }) {
    return {
        fullName: order.deliveryName,
        phone: order.deliveryPhone,
        address: order.deliveryAddress,
        state: order.deliveryState,
        lga: order.deliveryLga,
        instructions: order.deliveryInstructions
    }
}

// Where an order is in fulfilment. An order is only DELIVERED once the buyer confirms; while the
// seller has reported delivery but the buyer has not confirmed, the status is still SHIPPED and
// deliveryReportedAt is set.
function toFulfilmentResponse(order: { shippedAt: Date | null; shippingNote: string | null; deliveryReportedAt: Date | null; deliveryConfirmedAt: Date | null; deliveryAutoClosedAt: Date | null; fulfilmentType: "NOW" | "PRE_ORDER"; readyAt: Date | null }) {
    return {
        // NOW, or PRE_ORDER: a food order the seller approved for readyAt.
        fulfilmentType: order.fulfilmentType,
        readyAt: order.readyAt,
        shippedAt: order.shippedAt,
        shippingNote: order.shippingNote,
        deliveryReportedAt: order.deliveryReportedAt,
        deliveryConfirmedAt: order.deliveryConfirmedAt,
        // Set when the order was closed as delivered after 7 days without an answer from the buyer.
        deliveryAutoClosedAt: order.deliveryAutoClosedAt
    }
}

function parsePage(value: unknown): number | null {
    if (value === undefined) {
        return 1
    }

    const page = Number(value)
    return typeof value === "string" && Number.isSafeInteger(page) && page >= 1 ? page : null
}

function parseId(value: unknown): number | null {
    const id = Number(value)
    return Number.isSafeInteger(id) && id > 0 ? id : null
}

// A customer's order history: their paid checkouts, newest first. A checkout counts as paid once a
// payment for it is verified, even while settlement is still finishing.
const paidCheckoutWhere = (userId: number): Prisma.CheckoutWhereInput => ({
    userId,
    OR: [{ status: "COMPLETED" }, { paymentAttempts: { some: { status: "SUCCESS" } } }]
})

const successfulPaymentSelect = {
    where: { status: "SUCCESS" as const },
    orderBy: { id: "asc" as const },
    take: 1,
    select: { reference: true, provider: true, verifiedAt: true }
}

const orderItemSelect = {
    orderBy: { id: "asc" as const },
    select: { listingId: true, title: true, unitPrice: true, quantity: true }
}

// What a buyer sees of a refund: how much, where it stands and the note written for them.
const customerRefundSelect = {
    orderBy: { id: "asc" as const },
    select: { reference: true, amount: true, status: true, customerNote: true, expectedAt: true, createdAt: true, completedAt: true }
}

function toCustomerRefund(refund: { reference: string; amount: Prisma.Decimal; status: string; customerNote: string | null; expectedAt: Date | null; createdAt: Date; completedAt: Date | null }) {
    return {
        reference: refund.reference,
        amount: money(refund.amount),
        status: refund.status,
        note: refund.customerNote,
        expectedAt: refund.expectedAt,
        createdAt: refund.createdAt,
        completedAt: refund.completedAt
    }
}

// What a seller sees of a refund on their order, including the reason given to them.
const sellerRefundSelect = {
    orderBy: { id: "asc" as const },
    select: { reference: true, amount: true, status: true, reason: true, createdAt: true, completedAt: true }
}

function toSellerRefund(refund: { reference: string; amount: Prisma.Decimal; status: string; reason: string; createdAt: Date; completedAt: Date | null }) {
    return {
        reference: refund.reference,
        amount: money(refund.amount),
        status: refund.status,
        reason: refund.reason,
        createdAt: refund.createdAt,
        completedAt: refund.completedAt
    }
}

// The latest complaint about an order that has not been withdrawn, so order pages can link to it.
const latestDisputeSelect = {
    where: { status: { not: "WITHDRAWN" as const } },
    orderBy: { id: "desc" as const },
    take: 1,
    select: { id: true, status: true, outcome: true, reason: true }
}

function toLatestDispute(disputes: Array<{ id: number; status: string; outcome: string | null; reason: string }>) {
    return disputes[0] ?? null
}

const sellerNameSelect = { select: { sellerProfile: { select: { businessName: true, slug: true } } } }

function toPaymentSummary(payments: Array<{ reference: string; provider: string; verifiedAt: Date | null }>) {
    const payment = payments[0]
    return payment ? { reference: payment.reference, provider: payment.provider, paidAt: payment.verifiedAt } : null
}

export const listMyOrders = async (req: Request, res: Response) => {
    const page = parsePage(req.query.page)

    if (page === null) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    const where = paidCheckoutWhere(req.user!.id)
    const [total, checkouts] = await Promise.all([
        prisma.checkout.count({ where }),
        prisma.checkout.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            select: {
                id: true,
                status: true,
                total: true,
                createdAt: true,
                paymentAttempts: successfulPaymentSelect,
                orders: {
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        status: true,
                        total: true,
                        shippedAt: true,
                        shippingNote: true,
                        deliveryReportedAt: true,
                        deliveryConfirmedAt: true,
                        deliveryAutoClosedAt: true,
                        fulfilmentType: true,
                        readyAt: true,
                        refundedAmount: true,
                        refunds: customerRefundSelect,
                        disputes: latestDisputeSelect,
                        seller: sellerNameSelect,
                        orderItems: orderItemSelect
                    }
                }
            }
        })
    ])

    res.send({
        page,
        pageSize,
        total,
        orders: checkouts.map((checkout) => ({
            id: checkout.id,
            status: checkout.status,
            total: money(checkout.total),
            createdAt: checkout.createdAt,
            payment: toPaymentSummary(checkout.paymentAttempts),
            sellerOrders: checkout.orders.map((order) => ({
                id: order.id,
                status: order.status,
                total: money(order.total),
                seller: order.seller.sellerProfile,
                itemCount: order.orderItems.reduce((count, item) => count + item.quantity, 0),
                items: order.orderItems.map(toItemResponse),
                refundedAmount: money(order.refundedAmount),
                refunds: order.refunds.map(toCustomerRefund),
                dispute: toLatestDispute(order.disputes),
                ...toFulfilmentResponse(order)
            }))
        }))
    })
}

// Loads one of the customer's paid checkouts with everything the order pages show.
function findMyOrder(checkoutId: number, userId: number) {
    return prisma.checkout.findFirst({
        where: { id: checkoutId, ...paidCheckoutWhere(userId) },
        include: {
            paymentAttempts: successfulPaymentSelect,
            orders: {
                orderBy: { id: "asc" },
                include: { seller: sellerNameSelect, orderItems: orderItemSelect, refunds: customerRefundSelect, disputes: latestDisputeSelect }
            }
        }
    })
}

function toMyOrderResponse(checkout: NonNullable<Awaited<ReturnType<typeof findMyOrder>>>) {
    return {
        id: checkout.id,
        status: checkout.status,
        total: money(checkout.total),
        createdAt: checkout.createdAt,
        payment: toPaymentSummary(checkout.paymentAttempts),
        delivery: {
            fullName: checkout.deliveryName,
            phone: checkout.deliveryPhone,
            address: checkout.deliveryAddress,
            state: checkout.deliveryState,
            lga: checkout.deliveryLga,
            instructions: checkout.deliveryInstructions
        },
        sellerOrders: checkout.orders.map((order) => ({
            id: order.id,
            status: order.status,
            seller: order.seller.sellerProfile,
            subtotal: money(order.subtotal),
            shipping: money(order.shippingCost),
            total: money(order.total),
            items: order.orderItems.map(toItemResponse),
            refundedAmount: money(order.refundedAmount),
            refunds: order.refunds.map(toCustomerRefund),
            dispute: toLatestDispute(order.disputes),
            ...toFulfilmentResponse(order)
        }))
    }
}

export const getMyOrder = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const checkout = id === null ? null : await findMyOrder(id, req.user!.id)

    if (!checkout) {
        res.status(404).send({ message: "Order not found" })
        return
    }

    res.send(toMyOrderResponse(checkout))
}

// How many of the customer's orders the seller has reported as delivered and the customer has not
// yet confirmed. The site shows this beside "My orders" so the customer is asked to confirm.
export const countOrdersAwaitingConfirmation = async (req: Request, res: Response) => {
    const count = await prisma.order.count({
        where: {
            status: "SHIPPED",
            deliveryReportedAt: { not: null },
            checkout: { userId: req.user!.id }
        }
    })

    res.send({ count })
}

// The customer confirms they received one seller's order. This is the only way an order becomes
// DELIVERED: the seller's report alone is not proof of receipt, so it is only possible once the
// seller has reported delivery. Repeating the request after confirming changes nothing.
export const confirmOrderDelivery = async (req: Request, res: Response) => {
    const checkoutId = parseId(req.params.id)
    const orderId = parseId(req.params.orderId)
    const userId = req.user!.id
    const order = checkoutId === null || orderId === null ? null : await prisma.order.findFirst({
        where: { id: orderId, checkoutId, checkout: { userId } },
        select: { status: true, deliveryReportedAt: true }
    })

    if (!order || checkoutId === null || orderId === null) {
        res.status(404).send({ message: "Order not found" })
        return
    }

    if (order.status !== "DELIVERED") {
        if (order.status !== "SHIPPED") {
            res.status(409).send({
                message: order.status === "PAID" ? "This order has not been shipped yet" : "This order cannot be confirmed",
                code: "ORDER_STATUS_INVALID"
            })
            return
        }

        if (!order.deliveryReportedAt) {
            res.status(409).send({
                message: "The seller has not reported this order as delivered yet",
                code: "DELIVERY_NOT_REPORTED"
            })
            return
        }

        const confirmed = await prisma.order.updateMany({
            where: { id: orderId, status: "SHIPPED", deliveryReportedAt: { not: null } },
            data: { status: "DELIVERED", deliveryConfirmedAt: new Date() }
        })

        if (confirmed.count === 1) {
            queueNotification("delivery confirmed", () => notifyDeliveryConfirmed(orderId, "BUYER"))
        }
    }

    const checkout = await findMyOrder(checkoutId, userId)
    res.send(toMyOrderResponse(checkout!))
}

function parseSellerStatus(value: unknown): OrderStatus | undefined | null {
    if (value === undefined) {
        return undefined
    }

    return sellerVisibleStatuses.find((status) => status === value) ?? null
}

// A seller's orders to fulfil, newest first, with the fee the provider took from each one.
// Which complaints an order list is narrowed to. "awaiting-response" is the ones the seller must answer.
const complaintFilters = {
    "awaiting-response": { disputes: { some: { status: "OPEN" } } },
    active: { disputes: { some: { status: { in: ["OPEN", "SELLER_AGREED", "UNDER_REVIEW"] } } } },
    any: { disputes: { some: { status: { not: "WITHDRAWN" } } } },
    none: { disputes: { none: { status: { not: "WITHDRAWN" } } } }
} as const satisfies Record<string, Prisma.OrderWhereInput>

function parseComplaintFilter(value: unknown): Prisma.OrderWhereInput | undefined | null {
    if (value === undefined) {
        return undefined
    }

    return typeof value === "string" && Object.hasOwn(complaintFilters, value)
        ? complaintFilters[value as keyof typeof complaintFilters]
        : null
}

export const listSellerOrders = async (req: Request, res: Response) => {
    const page = parsePage(req.query.page)
    const status = parseSellerStatus(req.query.status)
    const complaintFilter = parseComplaintFilter(req.query.complaint)

    if (complaintFilter === null) {
        res.status(400).send({ message: `Complaint must be one of ${Object.keys(complaintFilters).join(", ")}` })
        return
    }

    if (page === null) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    if (status === null) {
        res.status(400).send({ message: `Status must be one of ${sellerVisibleStatuses.join(", ")}` })
        return
    }

    const where: Prisma.OrderWhereInput = {
        sellerId: req.user!.id,
        status: status ?? { in: sellerVisibleStatuses },
        ...complaintFilter
    }
    const [total, orders] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: {
                checkout: { select: { paymentAttempts: successfulPaymentSelect } },
                orderItems: orderItemSelect,
                refunds: sellerRefundSelect,
                disputes: latestDisputeSelect
            }
        })
    ])

    res.send({
        page,
        pageSize,
        total,
        orders: orders.map((order) => ({
            id: order.id,
            status: order.status,
            createdAt: order.createdAt,
            paidAt: order.checkout.paymentAttempts[0]?.verifiedAt ?? null,
            provider: order.checkout.paymentAttempts[0]?.provider ?? null,
            total: money(order.total),
            providerFee: money(order.providerFee),
            sellerReceives: money(order.sellerReceives),
            itemCount: order.orderItems.reduce((count, item) => count + item.quantity, 0),
            items: order.orderItems.map(toItemResponse),
            delivery: toDeliveryResponse(order),
            liabilityDeduction: money(order.liabilityDeduction),
            refundedAmount: money(order.refundedAmount),
            refunds: order.refunds.map(toSellerRefund),
            dispute: toLatestDispute(order.disputes),
            ...toFulfilmentResponse(order)
        }))
    })
}

// Loads one of the seller's paid orders.
function findSellerOrder(id: number, sellerId: number) {
    return prisma.order.findFirst({
        where: { id, sellerId, status: { in: sellerVisibleStatuses } },
        include: {
            checkout: { select: { paymentAttempts: successfulPaymentSelect } },
            orderItems: orderItemSelect,
            refunds: sellerRefundSelect,
            disputes: latestDisputeSelect
        }
    })
}

function toSellerOrderResponse(order: NonNullable<Awaited<ReturnType<typeof findSellerOrder>>>) {
    const payment = toPaymentSummary(order.checkout.paymentAttempts)

    return {
        id: order.id,
        status: order.status,
        createdAt: order.createdAt,
        paidAt: payment?.paidAt ?? null,
        provider: payment?.provider ?? null,
        subtotal: money(order.subtotal),
        shipping: money(order.shippingCost),
        total: money(order.total),
        providerFee: money(order.providerFee),
        sellerReceives: money(order.sellerReceives),
        items: order.orderItems.map(toItemResponse),
        delivery: toDeliveryResponse(order),
        liabilityDeduction: money(order.liabilityDeduction),
        refundedAmount: money(order.refundedAmount),
        refunds: order.refunds.map(toSellerRefund),
        dispute: toLatestDispute(order.disputes),
        ...toFulfilmentResponse(order)
    }
}

export const getSellerOrder = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const order = id === null ? null : await findSellerOrder(id, req.user!.id)

    if (!order) {
        res.status(404).send({ message: "Order not found" })
        return
    }

    res.send(toSellerOrderResponse(order))
}

// An optional note for the buyer, such as the courier and tracking number. Returns null when there
// is no note and undefined when the value is not acceptable.
function parseShippingNote(value: unknown): string | null | undefined {
    if (value === undefined || value === null) {
        return null
    }

    if (typeof value !== "string" || value.trim().length > maximumShippingNoteLength) {
        return undefined
    }

    return value.trim() || null
}

// The seller marks a paid order as shipped, with an optional note for the buyer. Repeating the
// request on an order that is already shipped changes nothing.
export const shipSellerOrder = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const sellerId = req.user!.id
    const note = parseShippingNote(req.body.note)

    if (note === undefined) {
        res.status(400).send({ message: `Shipping note must be text of at most ${maximumShippingNoteLength} characters` })
        return
    }

    const order = id === null ? null : await findSellerOrder(id, sellerId)

    if (!order || id === null) {
        res.status(404).send({ message: "Order not found" })
        return
    }

    if (order.status === "REFUNDED") {
        res.status(409).send({ message: "A refunded order cannot be shipped", code: "ORDER_STATUS_INVALID" })
        return
    }

    if (order.status === "PAID") {
        const shipped = await prisma.order.updateMany({
            where: { id, sellerId, status: "PAID" },
            data: { status: "SHIPPED", shippedAt: new Date(), shippingNote: note }
        })

        if (shipped.count === 1) {
            queueNotification("order shipped", () => notifyShipped(id))
        }
    }

    res.send(toSellerOrderResponse((await findSellerOrder(id, sellerId))!))
}

// The seller reports that a paid order was delivered. This is not final: the order stays SHIPPED
// until the buyer confirms receipt, and the buyer is asked to confirm. An order that was never
// marked shipped is marked shipped at the same time. Repeating the request changes nothing.
export const reportSellerOrderDelivered = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const sellerId = req.user!.id
    const order = id === null ? null : await findSellerOrder(id, sellerId)

    if (!order || id === null) {
        res.status(404).send({ message: "Order not found" })
        return
    }

    if (order.status === "REFUNDED") {
        res.status(409).send({ message: "A refunded order cannot be delivered", code: "ORDER_STATUS_INVALID" })
        return
    }

    if (order.status === "PAID" || (order.status === "SHIPPED" && !order.deliveryReportedAt)) {
        const reported = await prisma.$transaction(async (tx) => {
            const now = new Date()
            await tx.order.updateMany({
                where: { id, sellerId, status: "PAID" },
                data: { status: "SHIPPED", shippedAt: now }
            })
            const result = await tx.order.updateMany({
                where: { id, sellerId, status: "SHIPPED", deliveryReportedAt: null },
                data: { deliveryReportedAt: now }
            })
            return result.count
        })

        if (reported === 1) {
            queueNotification("delivery reported", () => notifyDeliveryReported(id))
        }
    }

    res.send(toSellerOrderResponse((await findSellerOrder(id, sellerId))!))
}
