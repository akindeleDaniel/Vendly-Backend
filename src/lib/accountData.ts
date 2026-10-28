import prisma from "./prisma.js"

// Everything StoreHatch holds about one person, as they would see it, for "download my data". It never includes
// password hashes, login codes or token secrets. For a seller it adds their shop, products and sales; buyers in
// those sales appear by first name and state only, as on the seller's own pages.
export async function collectAccountData(userId: number) {
    const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, name: true, email: true, role: true, createdAt: true, emailVerifiedAt: true, googleId: true, passwordHash: true, cartRemindersOff: true }
    })
    const money = (amount: { toFixed(digits: number): string } | null) => amount === null ? null : amount.toFixed(2)

    const [checkouts, productReviews, shopReviews, disputes, preOrders, cart, devices, profile] = await Promise.all([
        prisma.checkout.findMany({
            where: { userId, OR: [{ status: "COMPLETED" }, { paymentAttempts: { some: { status: "SUCCESS" } } }] },
            orderBy: { id: "asc" },
            select: {
                id: true, createdAt: true, total: true, status: true,
                deliveryName: true, deliveryPhone: true, deliveryAddress: true, deliveryState: true, deliveryLga: true, deliveryInstructions: true,
                orders: {
                    orderBy: { id: "asc" },
                    select: {
                        id: true, status: true, total: true, refundedAmount: true, shippedAt: true, deliveryConfirmedAt: true,
                        seller: { select: { sellerProfile: { select: { businessName: true } } } },
                        orderItems: { orderBy: { id: "asc" }, select: { title: true, quantity: true, unitPrice: true } },
                        refunds: { orderBy: { id: "asc" }, select: { amount: true, status: true, createdAt: true } }
                    }
                }
            }
        }),
        prisma.productReview.findMany({ where: { buyerId: userId }, orderBy: { id: "asc" }, select: { rating: true, comment: true, photoUrls: true, createdAt: true, listing: { select: { title: true } } } }),
        prisma.shopReview.findMany({ where: { buyerId: userId }, orderBy: { id: "asc" }, select: { rating: true, comment: true, photoUrls: true, createdAt: true, sellerProfile: { select: { businessName: true } } } }),
        prisma.dispute.findMany({
            where: { OR: [{ order: { checkout: { userId } } }, { order: { sellerId: userId } }] },
            orderBy: { id: "asc" },
            select: {
                id: true, orderId: true, reason: true, status: true, outcome: true, requestedAmount: true, createdAt: true,
                messages: { where: { authorId: userId }, orderBy: { id: "asc" }, select: { body: true, evidenceUrls: true, createdAt: true } }
            }
        }),
        prisma.preOrderRequest.findMany({ where: { buyerId: userId }, orderBy: { id: "asc" }, select: { status: true, readyAt: true, note: true, createdAt: true, seller: { select: { sellerProfile: { select: { businessName: true } } } } } }),
        prisma.cart.findUnique({ where: { userId }, select: { cartItems: { select: { quantity: true, listing: { select: { title: true } } } } } }),
        prisma.trustedDevice.findMany({ where: { userId }, orderBy: { id: "asc" }, select: { userAgent: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true } }),
        prisma.sellerProfile.findUnique({
            where: { userId },
            select: {
                businessName: true, slug: true, state: true, lga: true, location: true, logoUrl: true, bannerUrl: true, brandColor: true, about: true,
                instagramHandle: true, tiktokHandle: true, facebookHandle: true, xHandle: true, whatsappNumber: true, businessPhone: true,
                shippingPolicy: true, shippingCost: true, deliversEverywhere: true, foodOrderType: true, payoutTermsVersion: true, payoutTermsAcceptedAt: true,
                payoutAccounts: { select: { provider: true, status: true, bankName: true, accountName: true, accountNumberLast4: true, createdAt: true } }
            }
        })
    ])

    const seller = profile
        ? {
            shop: { ...profile, shippingCost: money(profile.shippingCost), payoutAccounts: undefined },
            payoutAccounts: profile.payoutAccounts,
            products: await prisma.listing.findMany({
                where: { userId, parentId: null },
                orderBy: { id: "asc" },
                select: { id: true, title: true, description: true, price: true, stockQuantity: true, category: true, imageUrl: true, createdAt: true, archivedAt: true, isDraft: true }
            }),
            sales: (await prisma.order.findMany({
                where: { sellerId: userId, status: { in: ["PAID", "SHIPPED", "DELIVERED", "REFUNDED"] } },
                orderBy: { id: "asc" },
                select: {
                    id: true, createdAt: true, status: true, total: true, refundedAmount: true, sellerReceives: true, deliveryName: true, deliveryState: true,
                    orderItems: { orderBy: { id: "asc" }, select: { title: true, quantity: true, unitPrice: true } }
                }
            })).map(({ deliveryName, ...order }) => ({
                ...order,
                total: money(order.total),
                refundedAmount: money(order.refundedAmount),
                sellerReceives: money(order.sellerReceives),
                buyer: deliveryName.trim().split(/\s+/)[0] ?? "",
                items: order.orderItems.map((item) => ({ title: item.title, quantity: item.quantity, unitPrice: money(item.unitPrice) })),
                orderItems: undefined
            }))
        }
        : null

    return {
        exportedAt: new Date(),
        account: {
            name: user.name,
            email: user.email,
            role: user.role,
            createdAt: user.createdAt,
            emailConfirmedAt: user.emailVerifiedAt,
            signsInWithGoogle: user.googleId !== null,
            hasPassword: user.passwordHash !== null,
            cartReminders: !user.cartRemindersOff
        },
        orders: checkouts.map((checkout) => ({
            id: checkout.id,
            createdAt: checkout.createdAt,
            status: checkout.status,
            total: money(checkout.total),
            delivery: {
                name: checkout.deliveryName, phone: checkout.deliveryPhone, address: checkout.deliveryAddress,
                state: checkout.deliveryState, lga: checkout.deliveryLga, instructions: checkout.deliveryInstructions
            },
            shops: checkout.orders.map((order) => ({
                orderId: order.id,
                shop: order.seller.sellerProfile?.businessName ?? null,
                status: order.status,
                total: money(order.total),
                refunded: money(order.refundedAmount),
                shippedAt: order.shippedAt,
                deliveredAt: order.deliveryConfirmedAt,
                items: order.orderItems.map((item) => ({ title: item.title, quantity: item.quantity, unitPrice: money(item.unitPrice) })),
                refunds: order.refunds.map((refund) => ({ amount: money(refund.amount), status: refund.status, createdAt: refund.createdAt }))
            }))
        })),
        reviews: [
            ...productReviews.map((review) => ({ about: review.listing.title, kind: "product", rating: review.rating, comment: review.comment, photoUrls: review.photoUrls, createdAt: review.createdAt })),
            ...shopReviews.map((review) => ({ about: review.sellerProfile.businessName, kind: "shop", rating: review.rating, comment: review.comment, photoUrls: review.photoUrls, createdAt: review.createdAt }))
        ],
        complaints: disputes.map((dispute) => ({ ...dispute, requestedAmount: money(dispute.requestedAmount), yourMessages: dispute.messages, messages: undefined })),
        preOrders: preOrders.map((request) => ({ shop: request.seller.sellerProfile?.businessName ?? null, status: request.status, readyAt: request.readyAt, note: request.note, createdAt: request.createdAt })),
        cart: (cart?.cartItems ?? []).map((item) => ({ title: item.listing.title, quantity: item.quantity })),
        trustedBrowsers: devices,
        seller
    }
}
