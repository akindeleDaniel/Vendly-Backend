import { Prisma } from "../generated/prisma/client.js"
import { payoutFeeTerms } from "./payoutTerms.js"

// Vendly never takes more than this share of one order's total to recover what a seller owes, so a
// seller is not left with nothing from a sale.
export const liabilityDeductionCapPercent = 50

const sellerLiabilityLockNamespace = 1447380558

function toKobo(amount: Prisma.Decimal): number {
    return amount.times(100).toNumber()
}

function fromKobo(kobo: number): Prisma.Decimal {
    return new Prisma.Decimal(kobo).dividedBy(100)
}

// Decides how much of each seller order Vendly keeps, in kobo, to recover what that seller owes for
// earlier refunds. Only sellers who accepted the current terms are charged, an order gives up at most
// the cap, and what other unpaid checkouts have already planned to take is counted so the same
// liability is never collected twice. Runs inside the payment-start transaction, which holds the
// per-seller locks taken here.
export async function planLiabilityDeductions(
    tx: Prisma.TransactionClient,
    checkoutId: number,
    orders: Array<{ id: number; sellerId: number; totalKobo: number }>
): Promise<Map<number, number>> {
    const plan = new Map<number, number>()
    const sellerIds = [...new Set(orders.map((order) => order.sellerId))].sort((a, b) => a - b)

    for (const sellerId of sellerIds) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${sellerLiabilityLockNamespace}::integer, ${sellerId}::integer)`
    }

    for (const sellerId of sellerIds) {
        const profile = await tx.sellerProfile.findUnique({
            where: { userId: sellerId },
            select: { payoutTermsVersion: true }
        })
        const sellerOrders = orders.filter((order) => order.sellerId === sellerId)

        if (profile?.payoutTermsVersion !== payoutFeeTerms.version) {
            sellerOrders.forEach((order) => plan.set(order.id, 0))
            continue
        }

        const open = await tx.sellerLiability.findMany({
            where: { sellerId, status: "OPEN" },
            select: { amount: true, recovered: true }
        })
        const outstandingKobo = open.reduce((sum, liability) => sum + toKobo(liability.amount.minus(liability.recovered)), 0)
        const reserved = await tx.order.aggregate({
            _sum: { liabilityDeduction: true },
            where: {
                sellerId,
                checkoutId: { not: checkoutId },
                status: "PENDING_PAYMENT",
                liabilityDeduction: { gt: 0 },
                checkout: { paymentAttempts: { some: { status: "PENDING" } } }
            }
        })
        let availableKobo = outstandingKobo - (reserved._sum.liabilityDeduction ? toKobo(reserved._sum.liabilityDeduction) : 0)

        for (const order of sellerOrders) {
            const capKobo = Math.floor(order.totalKobo * liabilityDeductionCapPercent / 100)
            const deductionKobo = Math.max(0, Math.min(availableKobo, capKobo))
            plan.set(order.id, deductionKobo)
            availableKobo -= deductionKobo
        }
    }

    return plan
}

// Splits a total in kobo across weights, in whole kobo, so the parts add up exactly.
export function allocateProportionally(totalKobo: number, weights: Array<{ key: number; weight: number }>): Map<number, number> {
    const weightSum = weights.reduce((sum, entry) => sum + entry.weight, 0)
    const result = new Map<number, number>()

    if (weightSum <= 0) {
        weights.forEach((entry) => result.set(entry.key, 0))
        return result
    }

    const shares = weights.map((entry) => {
        const exact = totalKobo * entry.weight / weightSum
        return { key: entry.key, whole: Math.floor(exact), remainder: exact - Math.floor(exact) }
    })
    let leftover = totalKobo - shares.reduce((sum, share) => sum + share.whole, 0)

    for (const share of [...shares].sort((a, b) => b.remainder - a.remainder)) {
        if (leftover <= 0) {
            break
        }

        share.whole += 1
        leftover -= 1
    }

    shares.forEach((share) => result.set(share.key, share.whole))
    return result
}

// Applies money Vendly kept from one of a seller's orders to that seller's open liabilities, oldest
// first. A liability that is fully recovered is closed. Returns how much was applied, in kobo.
export async function applyRecoveredAmount(
    tx: Prisma.TransactionClient,
    sellerId: number,
    orderId: number,
    recoveredKobo: number
): Promise<number> {
    const liabilities = await tx.sellerLiability.findMany({
        where: { sellerId, status: "OPEN" },
        orderBy: { id: "asc" }
    })
    let remainingKobo = recoveredKobo

    for (const liability of liabilities) {
        if (remainingKobo <= 0) {
            break
        }

        const takeKobo = Math.min(toKobo(liability.amount.minus(liability.recovered)), remainingKobo)

        if (takeKobo <= 0) {
            continue
        }

        // One row per liability and order, so applying the same order twice changes nothing.
        const created = await tx.liabilityRecovery.createMany({
            data: [{ liabilityId: liability.id, orderId, amount: fromKobo(takeKobo) }],
            skipDuplicates: true
        })

        if (created.count === 0) {
            continue
        }

        const updated = await tx.sellerLiability.update({
            where: { id: liability.id },
            data: { recovered: { increment: fromKobo(takeKobo) } }
        })

        if (updated.recovered.greaterThanOrEqualTo(updated.amount)) {
            await tx.sellerLiability.update({
                where: { id: liability.id },
                data: { status: "CLEARED", closedAt: new Date() }
            })
        }

        remainingKobo -= takeKobo
    }

    if (remainingKobo > 0) {
        console.error("Vendly kept more than the seller owed", { sellerId, orderId, excessKobo: remainingKobo })
    }

    return recoveredKobo - remainingKobo
}
