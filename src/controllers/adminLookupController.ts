import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma, type OrderStatus, type Role } from "../generated/prisma/client.js"

// Read-only lookups for administrators: what needs attention, and finding an order or a person when someone
// phones or emails. Nothing here changes anything, and no password hash, token or payment link is ever returned.

const pageSize = 20
const maximumSearchLength = 100
const orderStatuses: OrderStatus[] = ["PENDING_PAYMENT", "PAID", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"]
// What an administrator is normally looking for: orders that were actually paid.
const paidOrderStatuses: OrderStatus[] = ["PAID", "SHIPPED", "DELIVERED", "REFUNDED"]
const roles: Role[] = ["CONSUMER", "SELLER"]

function money(amount: Prisma.Decimal): string {
    return amount.toFixed(2)
}

function parseId(value: unknown): number | null {
    const id = Number(value)
    return Number.isSafeInteger(id) && id > 0 ? id : null
}

function parsePage(value: unknown): number | null {
    if (value === undefined) {
        return 1
    }

    const page = Number(value)
    return typeof value === "string" && Number.isSafeInteger(page) && page >= 1 ? page : null
}

function parseOptionalId(value: unknown): number | undefined | null {
    return value === undefined ? undefined : parseId(value)
}

// Undefined when no search was given, null when it is not text or too long.
function parseSearch(value: unknown): string | undefined | null {
    if (value === undefined) {
        return undefined
    }

    if (typeof value !== "string") {
        return null
    }

    const search = value.trim()
    return search.length === 0 ? undefined : search.length <= maximumSearchLength ? search : null
}

// ---- what needs attention ----

export const getAdminSummary = async (_req: Request, res: Response) => {
    const [complaintGroups, refundGroups, openRecoveryCases, openLiabilities, owed] = await Promise.all([
        prisma.dispute.groupBy({ by: ["status"], where: { status: { in: ["OPEN", "SELLER_AGREED", "UNDER_REVIEW"] } }, _count: { _all: true } }),
        prisma.refund.groupBy({ by: ["status"], where: { status: { in: ["PENDING", "PROCESSING", "NEEDS_ATTENTION", "FAILED"] } }, _count: { _all: true } }),
        prisma.paymentRecoveryCase.count({ where: { status: "OPEN" } }),
        prisma.sellerLiability.count({ where: { status: "OPEN" } }),
        prisma.sellerLiability.aggregate({ where: { status: "OPEN" }, _sum: { amount: true, recovered: true } })
    ])
    const complaints = (status: string) => complaintGroups.find((group) => group.status === status)?._count._all ?? 0
    const refunds = (status: string) => refundGroups.find((group) => group.status === status)?._count._all ?? 0
    const stillOwed = new Prisma.Decimal(owed._sum.amount ?? 0).minus(owed._sum.recovered ?? 0)

    res.send({
        complaints: {
            // Waiting for the seller to answer (nothing for an administrator to do yet).
            awaitingSeller: complaints("OPEN"),
            // Waiting for an administrator to approve or reject.
            awaitingDecision: complaints("SELLER_AGREED") + complaints("UNDER_REVIEW")
        },
        refunds: {
            pending: refunds("PENDING"),
            processing: refunds("PROCESSING"),
            needsAttention: refunds("NEEDS_ATTENTION"),
            failed: refunds("FAILED")
        },
        recoveryCases: { open: openRecoveryCases },
        liabilities: { open: openLiabilities, amountStillOwed: money(stillOwed) }
    })
}

// ---- orders ----

const orderListInclude = {
    checkout: { select: { user: { select: { id: true, name: true, email: true } } } },
    seller: { select: { id: true, email: true, sellerProfile: { select: { businessName: true } } } },
    orderItems: { orderBy: { id: "asc" as const }, select: { title: true, quantity: true } },
    disputes: { where: { status: { not: "WITHDRAWN" as const } }, orderBy: { id: "desc" as const }, take: 1, select: { id: true, status: true } }
} satisfies Prisma.OrderInclude

function orderSearchFilter(search: string): Prisma.OrderWhereInput {
    const numeric = /^\d+$/.test(search) ? Number(search) : null

    return {
        OR: [
            ...(numeric !== null && Number.isSafeInteger(numeric) ? [{ id: numeric }, { checkoutId: numeric }] : []),
            { checkout: { user: { email: { contains: search, mode: "insensitive" } } } },
            { checkout: { user: { name: { contains: search, mode: "insensitive" } } } },
            { seller: { email: { contains: search, mode: "insensitive" } } },
            { seller: { sellerProfile: { businessName: { contains: search, mode: "insensitive" } } } },
            { deliveryName: { contains: search, mode: "insensitive" } },
            // A payment reference as shown by Paystack or Flutterwave, which support staff are often given.
            { checkout: { paymentAttempts: { some: { OR: [{ reference: search }, { providerRef: search }] } } } }
        ]
    }
}

export const listAdminOrders = async (req: Request, res: Response) => {
    const page = parsePage(req.query.page)
    const search = parseSearch(req.query.search)
    const buyerId = parseOptionalId(req.query.buyerId)
    const sellerId = parseOptionalId(req.query.sellerId)
    const status = req.query.status === undefined ? undefined : orderStatuses.find((candidate) => candidate === req.query.status) ?? null

    if (page === null) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    if (search === null) {
        res.status(400).send({ message: `Search must be text of up to ${maximumSearchLength} characters` })
        return
    }

    if (status === null) {
        res.status(400).send({ message: `Status must be one of ${orderStatuses.join(", ")}` })
        return
    }

    if (buyerId === null || sellerId === null) {
        res.status(400).send({ message: "Buyer ID and seller ID must be positive whole numbers" })
        return
    }

    const where: Prisma.OrderWhereInput = {
        status: status ?? { in: paidOrderStatuses },
        ...(buyerId ? { checkout: { userId: buyerId } } : {}),
        ...(sellerId ? { sellerId } : {}),
        ...(search ? orderSearchFilter(search) : {})
    }
    const [total, orders] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
            where,
            include: orderListInclude,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (page - 1) * pageSize,
            take: pageSize
        })
    ])

    res.send({
        page,
        pageSize,
        total,
        orders: orders.map((order) => ({
            id: order.id,
            checkoutId: order.checkoutId,
            status: order.status,
            createdAt: order.createdAt,
            total: money(order.total),
            refundedAmount: money(order.refundedAmount),
            buyer: order.checkout.user,
            seller: { id: order.seller.id, email: order.seller.email, businessName: order.seller.sellerProfile?.businessName ?? null },
            itemCount: order.orderItems.reduce((count, item) => count + item.quantity, 0),
            items: order.orderItems,
            complaint: order.disputes[0] ?? null
        }))
    })
}

export const getAdminOrder = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const order = id === null ? null : await prisma.order.findUnique({
        where: { id },
        include: {
            checkout: {
                select: {
                    id: true,
                    status: true,
                    user: { select: { id: true, name: true, email: true } },
                    paymentAttempts: {
                        orderBy: { id: "asc" },
                        select: {
                            id: true,
                            provider: true,
                            reference: true,
                            providerRef: true,
                            status: true,
                            amount: true,
                            providerStatus: true,
                            failureReason: true,
                            verifiedAt: true,
                            createdAt: true,
                            recoveryCase: { select: { id: true, status: true, reason: true } }
                        }
                    }
                }
            },
            seller: { select: { id: true, email: true, sellerProfile: { select: { businessName: true, slug: true } } } },
            orderItems: { orderBy: { id: "asc" }, select: { listingId: true, title: true, quantity: true, unitPrice: true } },
            refunds: {
                orderBy: { id: "asc" },
                select: { id: true, reference: true, amount: true, status: true, reason: true, createdAt: true, completedAt: true }
            },
            disputes: { orderBy: { id: "desc" }, select: { id: true, status: true, outcome: true, reason: true, createdAt: true } }
        }
    })

    if (!order) {
        res.status(404).send({ message: "Order not found" })
        return
    }

    res.send({
        order: {
            id: order.id,
            checkoutId: order.checkoutId,
            status: order.status,
            fulfilmentType: order.fulfilmentType,
            readyAt: order.readyAt,
            createdAt: order.createdAt,
            subtotal: money(order.subtotal),
            shippingCost: money(order.shippingCost),
            total: money(order.total),
            providerFee: order.providerFee ? money(order.providerFee) : null,
            sellerReceives: order.sellerReceives ? money(order.sellerReceives) : null,
            refundedAmount: money(order.refundedAmount),
            liabilityDeduction: money(order.liabilityDeduction),
            items: order.orderItems.map((item) => ({
                listingId: item.listingId,
                title: item.title,
                quantity: item.quantity,
                unitPrice: money(item.unitPrice),
                lineTotal: money(item.unitPrice.times(item.quantity))
            })),
            buyer: order.checkout.user,
            seller: { id: order.seller.id, email: order.seller.email, businessName: order.seller.sellerProfile?.businessName ?? null, slug: order.seller.sellerProfile?.slug ?? null },
            delivery: {
                name: order.deliveryName,
                phone: order.deliveryPhone,
                address: order.deliveryAddress,
                state: order.deliveryState,
                lga: order.deliveryLga,
                instructions: order.deliveryInstructions
            },
            fulfilment: {
                shippedAt: order.shippedAt,
                shippingNote: order.shippingNote,
                deliveryReportedAt: order.deliveryReportedAt,
                deliveryConfirmedAt: order.deliveryConfirmedAt,
                deliveryAutoClosedAt: order.deliveryAutoClosedAt
            },
            checkoutStatus: order.checkout.status,
            payments: order.checkout.paymentAttempts.map((attempt) => ({
                id: attempt.id,
                provider: attempt.provider,
                reference: attempt.reference,
                providerReference: attempt.providerRef,
                status: attempt.status,
                amount: money(attempt.amount),
                providerStatus: attempt.providerStatus,
                failureReason: attempt.failureReason,
                verifiedAt: attempt.verifiedAt,
                createdAt: attempt.createdAt,
                recoveryCase: attempt.recoveryCase
            })),
            refunds: order.refunds.map((refund) => ({
                id: refund.id,
                reference: refund.reference,
                amount: money(refund.amount),
                status: refund.status,
                reason: refund.reason,
                createdAt: refund.createdAt,
                completedAt: refund.completedAt
            })),
            complaints: order.disputes
        }
    })
}

// ---- people ----

const userListSelect = {
    id: true,
    name: true,
    email: true,
    role: true,
    isAdmin: true,
    emailVerifiedAt: true,
    googleId: true,
    createdAt: true,
    sellerProfile: { select: { businessName: true, slug: true } }
} satisfies Prisma.UserSelect

type UserListRecord = Prisma.UserGetPayload<{ select: typeof userListSelect }>

function toUserSummary(user: UserListRecord) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isAdmin: user.isAdmin,
        emailConfirmed: user.emailVerifiedAt !== null,
        usesGoogle: user.googleId !== null,
        createdAt: user.createdAt,
        shop: user.sellerProfile
    }
}

export const listAdminUsers = async (req: Request, res: Response) => {
    const page = parsePage(req.query.page)
    const search = parseSearch(req.query.search)
    const role = req.query.role === undefined ? undefined : roles.find((candidate) => candidate === req.query.role) ?? null

    if (page === null) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    if (search === null) {
        res.status(400).send({ message: `Search must be text of up to ${maximumSearchLength} characters` })
        return
    }

    if (role === null) {
        res.status(400).send({ message: `Role must be one of ${roles.join(", ")}` })
        return
    }

    const numeric = search && /^\d+$/.test(search) ? Number(search) : null
    const where: Prisma.UserWhereInput = {
        ...(role ? { role } : {}),
        ...(req.query.admin === "true" ? { isAdmin: true } : {}),
        ...(search
            ? {
                OR: [
                    ...(numeric !== null && Number.isSafeInteger(numeric) ? [{ id: numeric }] : []),
                    { email: { contains: search, mode: "insensitive" as const } },
                    { name: { contains: search, mode: "insensitive" as const } },
                    { sellerProfile: { businessName: { contains: search, mode: "insensitive" as const } } }
                ]
            }
            : {})
    }
    const [total, users] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
            where,
            select: userListSelect,
            orderBy: { id: "desc" },
            skip: (page - 1) * pageSize,
            take: pageSize
        })
    ])

    res.send({ page, pageSize, total, users: users.map(toUserSummary) })
}

export const getAdminUser = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const user = id === null ? null : await prisma.user.findUnique({ where: { id }, select: userListSelect })

    if (!user || id === null) {
        res.status(404).send({ message: "User not found" })
        return
    }

    const [ordersAsBuyer, ordersAsSeller, activeComplaints, liabilities] = await Promise.all([
        prisma.order.count({ where: { checkout: { userId: id }, status: { in: paidOrderStatuses } } }),
        prisma.order.count({ where: { sellerId: id, status: { in: paidOrderStatuses } } }),
        prisma.dispute.count({ where: { status: { in: ["OPEN", "SELLER_AGREED", "UNDER_REVIEW"] }, order: { OR: [{ sellerId: id }, { checkout: { userId: id } }] } } }),
        prisma.sellerLiability.aggregate({ where: { sellerId: id, status: "OPEN" }, _count: { _all: true }, _sum: { amount: true, recovered: true } })
    ])

    res.send({
        user: {
            ...toUserSummary(user),
            ordersAsBuyer,
            ordersAsSeller,
            activeComplaints,
            openLiabilities: {
                count: liabilities._count._all,
                amountStillOwed: money(new Prisma.Decimal(liabilities._sum.amount ?? 0).minus(liabilities._sum.recovered ?? 0))
            }
        }
    })
}
