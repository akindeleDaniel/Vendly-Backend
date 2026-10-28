import prisma from "./prisma.js"
import { endAllSessions } from "./sessions.js"

// Deleting an account. Orders, payments, refunds and complaints must be kept (for the law, the payment providers and
// the other side of each order), so the account is not erased: everything that identifies the person is removed,
// and the records keep only what they need. Deleting is refused while something is still open, because the person
// would be needed to finish it.
export const deletedUserName = "Deleted user"

const openComplaintStatuses = ["OPEN", "SELLER_AGREED", "UNDER_REVIEW"] as const
const runningRefundStatuses = ["PENDING", "PROCESSING", "NEEDS_ATTENTION"] as const

export type DeletionBlocker = { code: string; message: string }

// What stops this account from being deleted right now. Empty when it can be deleted.
export async function deletionBlockers(userId: number): Promise<DeletionBlocker[]> {
    const now = new Date()
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { isAdmin: true } })
    const [buyingOrders, buyingComplaints, buyingRefunds, paying, sellingOrders, sellingComplaints, owed] = await Promise.all([
        prisma.order.count({ where: { checkout: { userId }, status: { in: ["PAID", "SHIPPED"] } } }),
        prisma.dispute.count({ where: { order: { checkout: { userId } }, status: { in: [...openComplaintStatuses] } } }),
        prisma.refund.count({ where: { order: { checkout: { userId } }, status: { in: [...runningRefundStatuses] } } }),
        prisma.checkout.count({ where: { userId, status: { in: ["PENDING", "PAYMENT_PENDING"] }, expiresAt: { gt: now } } }),
        prisma.order.count({ where: { sellerId: userId, status: { in: ["PAID", "SHIPPED"] } } }),
        prisma.dispute.count({ where: { order: { sellerId: userId }, status: { in: [...openComplaintStatuses] } } }),
        prisma.sellerLiability.count({ where: { sellerId: userId, status: "OPEN" } })
    ])
    const blockers: DeletionBlocker[] = []
    const add = (count: number, code: string, message: string) => count > 0 && blockers.push({ code, message })

    if (user.isAdmin) {
        blockers.push({ code: "ADMIN_ACCOUNT", message: "An administrator account cannot be deleted here. Ask a super administrator to remove your access first" })
    }

    add(buyingOrders, "ORDERS_ON_THE_WAY", `${buyingOrders} of your orders ${buyingOrders === 1 ? "is" : "are"} still on the way. Confirm delivery first`)
    add(buyingComplaints + sellingComplaints, "COMPLAINTS_OPEN", "You have a complaint that is still open")
    add(buyingRefunds, "REFUNDS_RUNNING", "A refund to you is still being processed")
    add(paying, "PAYMENT_IN_PROGRESS", "You have a payment in progress. Finish it or let it expire")
    add(sellingOrders, "ORDERS_TO_FULFIL", `${sellingOrders} of your shop's orders ${sellingOrders === 1 ? "is" : "are"} not delivered yet`)
    add(owed, "MONEY_OWED", "Your shop still owes StoreHatch for an earlier refund")

    return blockers
}

// Removes everything that identifies the person and closes their shop. Call only when deletionBlockers is empty.
export async function deleteAccount(userId: number): Promise<void> {
    const now = new Date()
    const removed = "Removed"

    await prisma.$transaction(async (tx) => {
        const profile = await tx.sellerProfile.findUnique({ where: { userId }, select: { id: true } })

        await tx.user.update({
            where: { id: userId },
            data: {
                name: deletedUserName,
                // The address is freed, so the person can sign up again later as someone new.
                email: `deleted-${userId}@deleted.invalid`,
                passwordHash: null,
                googleId: null,
                cartRemindersOff: true,
                deletedAt: now
            }
        })

        // Delivery details on their past orders and checkouts.
        await tx.order.updateMany({
            where: { checkout: { userId } },
            data: { deliveryName: deletedUserName, deliveryPhone: removed, deliveryAddress: removed, deliveryInstructions: null }
        })
        await tx.checkout.updateMany({
            where: { userId },
            data: { deliveryName: deletedUserName, deliveryPhone: removed, deliveryAddress: removed, deliveryInstructions: null }
        })

        // Things that only existed for them.
        await tx.cartItem.deleteMany({ where: { cart: { userId } } })
        await tx.cart.deleteMany({ where: { userId } })
        await tx.trustedDevice.deleteMany({ where: { userId } })
        await tx.emailOtp.deleteMany({ where: { userId } })
        await tx.preOrderRequest.updateMany({ where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: { in: ["REQUESTED", "APPROVED"] } }, data: { status: "CANCELLED" } })

        // A seller's shop closes: hidden, nothing on sale, no public contact details. Its sales records stay.
        if (profile) {
            await tx.sellerProfile.update({
                where: { id: profile.id },
                data: {
                    blockedAt: now,
                    blockReason: "Account deleted by its owner",
                    businessPhone: null,
                    whatsappNumber: null,
                    instagramHandle: null,
                    tiktokHandle: null,
                    facebookHandle: null,
                    xHandle: null,
                    about: null
                }
            })
            await tx.listing.updateMany({ where: { userId, archivedAt: null }, data: { archivedAt: now } })
            await tx.cartItem.deleteMany({ where: { listing: { userId } } })
        }
    })

    // Every login on every device ends at once.
    await endAllSessions(userId)
    await prisma.refreshToken.deleteMany({ where: { userId } })
}
