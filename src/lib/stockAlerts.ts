import type { Prisma } from "../generated/prisma/client.js"

// Low-stock alerts. Each shop has one number (3 unless the seller changes it); any product or option can have its own,
// and an option without one uses its product's. 0 turns the alerts off. A seller is emailed when a sale takes an item
// from above its number to at or below it, and again when it sells out. Because the alert comes from the sale that
// crossed the line, it is sent once per drop: nothing more until the seller restocks above the number.
export const defaultLowStockThreshold = 3
export const maximumLowStockThreshold = 1000

export type StockStatus = "in_stock" | "low" | "sold_out"

export type StockAlert = {
    sellerId: number
    listingId: number
    title: string
    left: number
    kind: "low" | "sold_out"
}

// A whole number from 0 to 1000; for a product or option, null too (use the product's or the shop's number).
export function parseLowStockThreshold(value: unknown, allowNull: boolean): number | null | undefined | "invalid" {
    if (value === undefined) {
        return undefined
    }

    if (value === null) {
        return allowNull ? null : "invalid"
    }

    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximumLowStockThreshold ? value : "invalid"
}

export const lowStockThresholdProblem = `Low-stock alert must be a whole number from 0 to ${maximumLowStockThreshold}`

export function effectiveThreshold(own: number | null, product: number | null | undefined, shop: number | null | undefined): number {
    return own ?? product ?? shop ?? defaultLowStockThreshold
}

export function stockStatus(stock: number, threshold: number): StockStatus {
    return stock <= 0 ? "sold_out" : threshold > 0 && stock <= threshold ? "low" : "in_stock"
}

// After a sale has taken stock away (inside the same transaction), the items whose sale crossed their alert line.
// sold maps each listing to how many were just sold.
export async function findStockAlerts(tx: Prisma.TransactionClient, sold: Map<number, number>): Promise<StockAlert[]> {
    if (sold.size === 0) {
        return []
    }

    const listings = await tx.listing.findMany({
        where: { id: { in: [...sold.keys()] } },
        select: {
            id: true,
            userId: true,
            title: true,
            stockQuantity: true,
            lowStockThreshold: true,
            parent: { select: { lowStockThreshold: true } },
            user: { select: { sellerProfile: { select: { lowStockThreshold: true } } } }
        },
        orderBy: { id: "asc" }
    })
    const alerts: StockAlert[] = []

    for (const listing of listings) {
        const threshold = effectiveThreshold(listing.lowStockThreshold, listing.parent?.lowStockThreshold, listing.user.sellerProfile?.lowStockThreshold)

        if (threshold === 0) {
            continue
        }

        const after = listing.stockQuantity
        const before = after + (sold.get(listing.id) ?? 0)

        // A sale that sells out an item only sends the sold-out alert, even if it also went past the low line.
        if (before > 0 && after <= 0) {
            alerts.push({ sellerId: listing.userId, listingId: listing.id, title: listing.title, left: 0, kind: "sold_out" })
        } else if (before > threshold && after <= threshold) {
            alerts.push({ sellerId: listing.userId, listingId: listing.id, title: listing.title, left: after, kind: "low" })
        }
    }

    return alerts
}
