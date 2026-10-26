import prisma from "./prisma.js"
import { Prisma } from "../generated/prisma/client.js"
import config from "../config.js"

// Two limits that cap what a bad seller can cost while the platform has no income of its own:
// - the most one seller's order may be worth (MAX_ORDER_VALUE, in naira), so a refund on any order is bounded;
// - the most a seller may owe for unrecovered refunds (SELLER_DEBT_LIMIT, in naira); past it the seller takes no
//   new orders until the debt is repaid, written off or cleared.
// Either is switched off by setting it to 0. They are read when used, so a change to the setting applies at once.

export type OrderLimitSeller = {
    sellerId: number
    seller: { businessName: string; slug: string }
    subtotal: Prisma.Decimal
    shipping: Prisma.Decimal
}

export class OrderLimitError extends Error {
    constructor(
        readonly code: "CHECKOUT_ORDER_TOO_LARGE" | "CHECKOUT_ITEMS_UNAVAILABLE",
        message: string,
        readonly details: Record<string, unknown>
    ) {
        super(message)
    }
}

// What each of the given sellers still owes for refunds that were charged to them.
export async function openDebtBySeller(client: Prisma.TransactionClient | typeof prisma, sellerIds: number[]): Promise<Map<number, Prisma.Decimal>> {
    const result = new Map<number, Prisma.Decimal>()

    if (sellerIds.length === 0) {
        return result
    }

    const totals = await client.sellerLiability.groupBy({
        by: ["sellerId"],
        where: { sellerId: { in: sellerIds }, status: "OPEN" },
        _sum: { amount: true, recovered: true }
    })

    for (const row of totals) {
        result.set(row.sellerId, new Prisma.Decimal(row._sum.amount ?? 0).minus(row._sum.recovered ?? 0))
    }

    return result
}

export function overDebtLimit(owed: Prisma.Decimal | undefined): boolean {
    return config.sellerDebtLimit !== null && owed !== undefined && owed.greaterThan(config.sellerDebtLimit)
}

// Refuses a checkout that holds an order above the limit, or an order from a seller who is over the debt limit.
// The buyer is never told about a seller's debt, only that the shop is not taking orders right now.
export async function assertOrderLimits(client: Prisma.TransactionClient | typeof prisma, sellers: OrderLimitSeller[]): Promise<void> {
    const limit = config.maximumOrderValue

    if (limit !== null) {
        for (const seller of sellers) {
            const total = seller.subtotal.plus(seller.shipping)

            if (total.greaterThan(limit)) {
                throw new OrderLimitError(
                    "CHECKOUT_ORDER_TOO_LARGE",
                    `An order from ${seller.seller.businessName} can be at most ₦${limit.toLocaleString("en-NG")} for now. Please reduce the items or split the order.`,
                    { seller: seller.seller, orderTotal: total.toFixed(2), limit: new Prisma.Decimal(limit).toFixed(2) }
                )
            }
        }
    }

    if (config.sellerDebtLimit !== null) {
        const owed = await openDebtBySeller(client, sellers.map((seller) => seller.sellerId))

        for (const seller of sellers) {
            if (overDebtLimit(owed.get(seller.sellerId))) {
                throw new OrderLimitError(
                    "CHECKOUT_ITEMS_UNAVAILABLE",
                    `${seller.seller.businessName} is not taking new orders at the moment`,
                    { seller: seller.seller }
                )
            }
        }
    }
}
