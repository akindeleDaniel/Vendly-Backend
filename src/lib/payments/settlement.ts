import { Prisma } from "../../generated/prisma/client.js"
import { acquireCheckoutCreationLock } from "../../controllers/checkoutController.js"
import prisma from "../prisma.js"
import { notifyPaymentSettled, queueNotification } from "../notifications.js"
import { allocateProportionally, applyRecoveredAmount } from "../liabilities.js"
import type { SellerShare } from "./types.js"

export type SettlementResult = "settled" | "already_settled" | "needs_review"

const maximumSerializationRetries = 3

class SettlementNeedsReview extends Error {}

// Completes the checkout paid by a verified (SUCCESS) payment attempt, exactly once:
// checkout COMPLETED, held reservations CONSUMED, listing stock reduced by the reserved
// quantities, orders PAID, and only the cart quantities this checkout covered removed.
// Webhooks, the status endpoint and reconciliation all call this; repeated or concurrent calls
// are safe because every step is conditional on the checkout not being COMPLETED yet.
// A paid checkout whose stock is no longer held (for example after a late payment) is not
// settled automatically: it returns "needs_review" and is logged for manual recovery.
export async function settleCheckoutPayment(attemptId: number): Promise<SettlementResult> {
    for (let attempt = 1; ; attempt++) {
        try {
            const result = await settleOnce(attemptId)

            // Only the call that actually settled the checkout sends the receipt and the new-order alerts.
            if (result === "settled") {
                queueNotification("payment settled", () => notifyPaymentSettled(attemptId))
            }

            return result
        } catch (error) {
            if (error instanceof SettlementNeedsReview) {
                await openRecoveryCase(attemptId, error.message)
                return "needs_review"
            }

            const serializationFailure = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"

            if (!serializationFailure || attempt >= maximumSerializationRetries) {
                throw error
            }
        }
    }
}

// Records the payment for manual recovery once; later calls for the same payment do nothing.
async function openRecoveryCase(attemptId: number, reason: string): Promise<void> {
    try {
        await prisma.paymentRecoveryCase.create({ data: { paymentAttemptId: attemptId, reason } })
        console.error("Payment settlement needs review", { attemptId, reason })
    } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
            throw error
        }
    }
}

async function settleOnce(attemptId: number): Promise<SettlementResult> {
    return prisma.$transaction(async (tx) => {
        const paymentAttempt = await tx.paymentAttempt.findUniqueOrThrow({
            where: { id: attemptId },
            select: { status: true, provider: true, sellerShares: true, vendlyShareKobo: true, checkoutId: true, checkout: { select: { userId: true } } }
        })

        if (paymentAttempt.status !== "SUCCESS") {
            throw new Error(`Payment attempt ${attemptId} is not verified as successful`)
        }

        await acquireCheckoutCreationLock(tx, paymentAttempt.checkout.userId)

        const checkout = await tx.checkout.findUniqueOrThrow({
            where: { id: paymentAttempt.checkoutId },
            include: {
                checkoutItems: { select: { listingId: true, quantity: true } },
                inventoryReservations: { select: { listingId: true, quantity: true, status: true } },
                orders: {
                    select: {
                        id: true,
                        sellerId: true,
                        status: true,
                        total: true,
                        liabilityDeduction: true,
                        preOrderRequestId: true,
                        seller: {
                            select: {
                                sellerProfile: {
                                    select: {
                                        payoutAccounts: {
                                            where: { provider: paymentAttempt.provider },
                                            select: { subaccountCode: true }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                paymentAttempts: { where: { status: "SUCCESS" }, select: { id: true } }
            }
        })

        if (checkout.status === "COMPLETED") {
            if (!checkout.paymentAttempts.some(({ id }) => id === attemptId) || checkout.paymentAttempts.length > 1) {
                console.error("Checkout has more than one successful payment", { checkoutId: checkout.id, attemptId })
            }

            return "already_settled"
        }

        const heldReservations = checkout.inventoryReservations.filter(
            ({ status }) => status === "ACTIVE" || status === "PROTECTED"
        )

        if (
            checkout.inventoryReservations.length === 0 ||
            heldReservations.length !== checkout.inventoryReservations.length
        ) {
            throw new SettlementNeedsReview(`Checkout ${checkout.id} stock is no longer held`)
        }

        if (checkout.orders.length === 0 || checkout.orders.some(({ status }) => status !== "PENDING_PAYMENT")) {
            throw new SettlementNeedsReview(`Checkout ${checkout.id} orders are not awaiting payment`)
        }

        const completed = await tx.checkout.updateMany({
            where: { id: checkout.id, status: { in: ["PENDING", "PAYMENT_PENDING", "EXPIRED"] } },
            data: { status: "COMPLETED" }
        })

        if (completed.count !== 1) {
            return "already_settled"
        }

        for (const reservation of heldReservations) {
            const decremented = await tx.listing.updateMany({
                where: { id: reservation.listingId, stockQuantity: { gte: reservation.quantity } },
                data: { stockQuantity: { decrement: reservation.quantity } }
            })

            if (decremented.count !== 1) {
                throw new SettlementNeedsReview(`Listing ${reservation.listingId} has less stock than was reserved`)
            }
        }

        await tx.inventoryReservation.updateMany({
            where: { checkoutId: checkout.id, status: { in: ["ACTIVE", "PROTECTED"] } },
            data: { status: "CONSUMED" }
        })
        await tx.order.updateMany({
            where: { checkoutId: checkout.id, status: "PENDING_PAYMENT" },
            data: { status: "PAID" }
        })

        // A pre-order approval is used up by the payment, even if it lapsed while the buyer was paying.
        const usedRequestIds = checkout.orders.flatMap((order) => order.preOrderRequestId === null ? [] : [order.preOrderRequestId])

        if (usedRequestIds.length > 0) {
            await tx.preOrderRequest.updateMany({
                where: { id: { in: usedRequestIds }, status: { in: ["APPROVED", "EXPIRED"] } },
                data: { status: "USED" }
            })
        }

        // Record what the provider reported for each seller's share, so sellers see the real fee.
        const shares = Array.isArray(paymentAttempt.sellerShares) ? paymentAttempt.sellerShares as SellerShare[] : []

        // Vendly may have kept part of some seller orders to recover what those sellers owe for earlier
        // refunds. Paystack reports Vendly's share as one lump, so it is shared across those orders in
        // proportion to what each planned to give up; Flutterwave reports it for each seller.
        const plannedOrders = checkout.orders.filter((order) => order.liabilityDeduction.greaterThan(0))
        const lumpShares = paymentAttempt.vendlyShareKobo === null
            ? null
            : allocateProportionally(
                paymentAttempt.vendlyShareKobo,
                plannedOrders.map((order) => ({ key: order.id, weight: order.liabilityDeduction.times(100).toNumber() }))
            )

        for (const order of checkout.orders) {
            const subaccountCode = order.seller.sellerProfile?.payoutAccounts[0]?.subaccountCode
            const share = shares.find((candidate) => candidate.subaccountCode === subaccountCode)
            const totalKobo = order.total.times(100).toNumber()
            const plannedKobo = order.liabilityDeduction.times(100).toNumber()
            // What Vendly actually kept: the provider's per-seller figure, else this order's part of its
            // reported share, else what was planned if the provider reported nothing.
            const retainedKobo = plannedKobo === 0 ? 0 : (share?.retainedKobo ?? lumpShares?.get(order.id) ?? plannedKobo)

            if (share) {
                await tx.order.update({
                    where: { id: order.id },
                    data: {
                        sellerReceives: new Prisma.Decimal(share.receivedKobo).dividedBy(100),
                        providerFee: new Prisma.Decimal(share.feeKobo ?? totalKobo - share.receivedKobo - retainedKobo).dividedBy(100)
                    }
                })
            }

            if (plannedKobo > 0) {
                await tx.order.update({
                    where: { id: order.id },
                    data: { liabilityDeduction: new Prisma.Decimal(retainedKobo).dividedBy(100) }
                })

                if (retainedKobo > 0) {
                    await applyRecoveredAmount(tx, order.sellerId, order.id, retainedKobo)
                }
            }
        }

        // Items added to the cart after checkout stay in the cart.
        const cart = await tx.cart.findUnique({ where: { userId: checkout.userId }, select: { id: true } })

        if (cart) {
            for (const item of checkout.checkoutItems) {
                await tx.cartItem.deleteMany({
                    where: { cartId: cart.id, listingId: item.listingId, quantity: { lte: item.quantity } }
                })
                await tx.cartItem.updateMany({
                    where: { cartId: cart.id, listingId: item.listingId, quantity: { gt: item.quantity } },
                    data: { quantity: { decrement: item.quantity } }
                })
            }
        }

        return "settled"
    }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    })
}
