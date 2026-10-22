import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma, type OrderStatus } from "../generated/prisma/client.js"

const dayMs = 24 * 60 * 60 * 1000
const paidStatuses: OrderStatus[] = ["PAID", "SHIPPED", "DELIVERED", "REFUNDED"]

function money(value: Prisma.Decimal | null | undefined): string {
    return new Prisma.Decimal(value ?? 0).toFixed(2)
}

// Money that went through Vendly in a period: what buyers paid, what was refunded back, and the difference. This is
// the value of sales on the platform, not Vendly's own income: Vendly takes no commission on orders, so a seller's
// share goes to the seller and the provider's fee comes out of it.
async function salesSince(since: Date | null) {
    const [paid, refunded] = await Promise.all([
        prisma.paymentAttempt.aggregate({ where: { status: "SUCCESS", ...(since ? { verifiedAt: { gte: since } } : {}) }, _sum: { amount: true }, _count: { _all: true } }),
        prisma.refund.aggregate({ where: { status: "SUCCEEDED", ...(since ? { completedAt: { gte: since } } : {}) }, _sum: { amount: true }, _count: { _all: true } })
    ])
    const net = new Prisma.Decimal(paid._sum.amount ?? 0).minus(refunded._sum.amount ?? 0)

    return {
        payments: paid._count._all,
        paid: money(paid._sum.amount),
        refunds: refunded._count._all,
        refunded: money(refunded._sum.amount),
        net: money(net)
    }
}

// The platform figures for super administrators: people, sales, refunds, complaints, sellers and what needs attention.
export const getPlatformSummary = async (_req: Request, res: Response) => {
    const now = new Date()
    const days = (count: number) => new Date(now.getTime() - count * dayMs)
    const [
        usersByRole, admins, newUsers7, newUsers30, unconfirmed,
        shops, blockedShops, warnedShops, shopsWithPayout, listingsOnSale,
        ordersByStatus, orders7, orders30,
        salesAll, sales30, sales7, salesToday,
        refundGroups, refundInProgress,
        complaintGroups, overdueSeller,
        liabilities, recoveryCases,
        reportedProductReviews, reportedShopReviews, preOrdersWaiting,
        topSellerGroups
    ] = await Promise.all([
        prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
        prisma.user.count({ where: { isAdmin: true } }),
        prisma.user.count({ where: { createdAt: { gte: days(7) } } }),
        prisma.user.count({ where: { createdAt: { gte: days(30) } } }),
        prisma.user.count({ where: { emailVerifiedAt: null } }),
        prisma.sellerProfile.count(),
        prisma.sellerProfile.count({ where: { blockedAt: { not: null } } }),
        prisma.sellerProfile.count({ where: { strikeWarnedAt: { not: null }, blockedAt: null } }),
        prisma.sellerProfile.count({ where: { payoutAccounts: { some: { status: "ACTIVE" } } } }),
        prisma.listing.count({ where: { archivedAt: null, parentId: null } }),
        prisma.order.groupBy({ by: ["status"], where: { status: { in: paidStatuses } }, _count: { _all: true } }),
        prisma.order.count({ where: { status: { in: paidStatuses }, createdAt: { gte: days(7) } } }),
        prisma.order.count({ where: { status: { in: paidStatuses }, createdAt: { gte: days(30) } } }),
        salesSince(null),
        salesSince(days(30)),
        salesSince(days(7)),
        salesSince(new Date(now.getFullYear(), now.getMonth(), now.getDate())),
        prisma.refund.groupBy({ by: ["status"], where: { status: { in: ["PENDING", "PROCESSING", "NEEDS_ATTENTION", "FAILED"] } }, _count: { _all: true } }),
        prisma.refund.aggregate({ where: { status: { in: ["PENDING", "PROCESSING", "NEEDS_ATTENTION"] } }, _sum: { amount: true } }),
        prisma.dispute.groupBy({ by: ["status"], where: { status: { in: ["OPEN", "SELLER_AGREED", "UNDER_REVIEW"] } }, _count: { _all: true } }),
        prisma.dispute.count({ where: { status: "OPEN", responseDueAt: { lt: now } } }),
        prisma.sellerLiability.aggregate({ where: { status: "OPEN" }, _count: { _all: true }, _sum: { amount: true, recovered: true } }),
        prisma.paymentRecoveryCase.count({ where: { status: "OPEN" } }),
        prisma.productReview.count({ where: { reportedAt: { not: null }, hiddenAt: null } }),
        prisma.shopReview.count({ where: { reportedAt: { not: null }, hiddenAt: null } }),
        prisma.preOrderRequest.count({ where: { status: "REQUESTED" } }),
        prisma.order.groupBy({
            by: ["sellerId"],
            where: { status: { in: paidStatuses }, createdAt: { gte: days(30) } },
            _sum: { total: true },
            _count: { _all: true },
            orderBy: { _sum: { total: "desc" } },
            take: 5
        })
    ])
    const people = (role: string) => usersByRole.find((group) => group.role === role)?._count._all ?? 0
    const orderCount = (status: string) => ordersByStatus.find((group) => group.status === status)?._count._all ?? 0
    const refundCount = (status: string) => refundGroups.find((group) => group.status === status)?._count._all ?? 0
    const complaintCount = (status: string) => complaintGroups.find((group) => group.status === status)?._count._all ?? 0
    const topSellerNames = new Map((await prisma.sellerProfile.findMany({
        where: { userId: { in: topSellerGroups.map((group) => group.sellerId) } },
        select: { userId: true, businessName: true, slug: true }
    })).map((shop) => [shop.userId, shop]))

    res.send({
        generatedAt: now,
        users: {
            total: people("CONSUMER") + people("SELLER"),
            buyers: people("CONSUMER"),
            sellers: people("SELLER"),
            admins,
            joinedLast7Days: newUsers7,
            joinedLast30Days: newUsers30,
            emailNotConfirmed: unconfirmed
        },
        shops: { total: shops, withPayoutAccount: shopsWithPayout, warned: warnedShops, blocked: blockedShops, listingsOnSale },
        orders: {
            paid: orderCount("PAID") + orderCount("SHIPPED") + orderCount("DELIVERED") + orderCount("REFUNDED"),
            toShip: orderCount("PAID"),
            shipped: orderCount("SHIPPED"),
            delivered: orderCount("DELIVERED"),
            refunded: orderCount("REFUNDED"),
            last7Days: orders7,
            last30Days: orders30
        },
        // The value of sales through Vendly (not Vendly's own income, which is nothing while it takes no commission).
        sales: { allTime: salesAll, last30Days: sales30, last7Days: sales7, today: salesToday },
        refunds: {
            pending: refundCount("PENDING"),
            processing: refundCount("PROCESSING"),
            needsAttention: refundCount("NEEDS_ATTENTION"),
            failed: refundCount("FAILED"),
            amountInProgress: money(refundInProgress._sum.amount)
        },
        complaints: {
            awaitingSeller: complaintCount("OPEN"),
            overdueSellerResponse: overdueSeller,
            sellerAgreedAwaitingApproval: complaintCount("SELLER_AGREED"),
            awaitingDecision: complaintCount("SELLER_AGREED") + complaintCount("UNDER_REVIEW")
        },
        sellerDebts: {
            open: liabilities._count._all,
            amountStillOwed: money(new Prisma.Decimal(liabilities._sum.amount ?? 0).minus(liabilities._sum.recovered ?? 0)),
            recoveryCasesOpen: recoveryCases
        },
        needsAttention: {
            reportedReviews: reportedProductReviews + reportedShopReviews,
            preOrdersAwaitingSeller: preOrdersWaiting
        },
        topSellersLast30Days: topSellerGroups.map((group) => ({
            sellerId: group.sellerId,
            businessName: topSellerNames.get(group.sellerId)?.businessName ?? null,
            slug: topSellerNames.get(group.sellerId)?.slug ?? null,
            orders: group._count._all,
            sales: money(group._sum.total)
        }))
    })
}
