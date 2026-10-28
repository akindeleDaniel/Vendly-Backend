import prisma from "./prisma.js"
import type { Prisma } from "../generated/prisma/client.js"
import { heldReservationConditions } from "./inventoryReservations.js"
import { isHttpsUrl, maximumStockQuantity, priceProblem } from "./inputRules.js"

// Options of a product, for example colour and then size. A listing can have none (it then works exactly as it
// always has), or a list of options, each with its own price and optional photo. An option either has sizes, each
// with its own stock, or has stock of its own.
//
// Each thing that can be bought is stored as a hidden listing that points back to the product through
// Listing.parentId ("Blue", or "Blue" / "M"). Carts, checkouts, stock reservations, orders, refunds and
// complaints therefore work on options without knowing they exist. The product itself is never bought.
export const maximumOptions = 20
export const maximumSizesPerOption = 20
export const maximumOptionChoices = 100
export const maximumOptionLabelLength = 40

export class ReservedStockConflict extends Error {
    constructor(readonly reservedQuantity: number, readonly label: string) {
        super("Requested stock is below the quantity currently reserved")
    }
}

export type OptionInput = {
    label: string
    price: number
    imageUrl: string | null
    // Set when the option has no sizes.
    stockQuantity: number | null
    sizes: Array<{ label: string; stockQuantity: number }>
}

function stockProblem(value: unknown): string | null {
    if (!Number.isInteger(value) || (value as number) < 0) {
        return "Stock quantity must be a whole number greater than or equal to 0"
    }

    return (value as number) > maximumStockQuantity ? `Stock quantity cannot be more than ${maximumStockQuantity.toLocaleString("en-NG")}` : null
}

function readLabel(value: unknown, what: string): string | { error: string } {
    if (typeof value !== "string" || value.trim().length === 0) {
        return { error: `Each ${what} needs a name` }
    }

    const label = value.trim().replace(/\s+/g, " ")
    return label.length > maximumOptionLabelLength ? { error: `A ${what} name must be ${maximumOptionLabelLength} characters or fewer` } : label
}

// The options from a request body. An option with no price of its own uses the listing's price.
export function readOptions(value: unknown, defaultPrice: number): OptionInput[] | { error: string } {
    if (!Array.isArray(value)) {
        return { error: "Options must be a list" }
    }

    if (value.length > maximumOptions) {
        return { error: `A product can have at most ${maximumOptions} options` }
    }

    const options: OptionInput[] = []
    const seen = new Set<string>()
    let choices = 0

    for (const raw of value) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            return { error: "Each option must be an object" }
        }

        const item = raw as Record<string, unknown>
        const label = readLabel(item.label, "option")

        if (typeof label !== "string") {
            return label
        }

        if (seen.has(label.toLowerCase())) {
            return { error: `The option "${label}" is listed twice` }
        }

        seen.add(label.toLowerCase())

        let price = defaultPrice

        if (item.price !== undefined && item.price !== null) {
            const problem = priceProblem(item.price)

            if (problem) {
                return { error: `Option "${label}": ${problem}` }
            }

            price = Number(item.price)
        }

        if (item.imageUrl !== undefined && item.imageUrl !== null && !isHttpsUrl(item.imageUrl)) {
            return { error: `Option "${label}": the photo must be an https link` }
        }

        const sizesGiven = item.sizes !== undefined && item.sizes !== null

        if (sizesGiven && !Array.isArray(item.sizes)) {
            return { error: `Option "${label}": sizes must be a list` }
        }

        const rawSizes = (sizesGiven ? item.sizes : []) as unknown[]
        const sizes: OptionInput["sizes"] = []

        if (rawSizes.length > maximumSizesPerOption) {
            return { error: `An option can have at most ${maximumSizesPerOption} sizes` }
        }

        const seenSizes = new Set<string>()

        for (const rawSize of rawSizes) {
            if (typeof rawSize !== "object" || rawSize === null || Array.isArray(rawSize)) {
                return { error: `Option "${label}": each size must be an object` }
            }

            const size = rawSize as Record<string, unknown>
            const sizeLabel = readLabel(size.label, "size")

            if (typeof sizeLabel !== "string") {
                return sizeLabel
            }

            if (seenSizes.has(sizeLabel.toLowerCase())) {
                return { error: `Option "${label}": the size "${sizeLabel}" is listed twice` }
            }

            seenSizes.add(sizeLabel.toLowerCase())
            const problem = stockProblem(size.stockQuantity)

            if (problem) {
                return { error: `Option "${label}", size "${sizeLabel}": ${problem}` }
            }

            sizes.push({ label: sizeLabel, stockQuantity: size.stockQuantity as number })
        }

        let stockQuantity: number | null = null

        if (sizes.length > 0) {
            if (item.stockQuantity !== undefined && item.stockQuantity !== null) {
                return { error: `Option "${label}" has sizes, so give the stock on each size and not on the option` }
            }
        } else {
            const problem = stockProblem(item.stockQuantity)

            if (problem) {
                return { error: `Option "${label}": ${problem}` }
            }

            stockQuantity = item.stockQuantity as number
        }

        choices += Math.max(sizes.length, 1)
        options.push({ label, price, imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : null, stockQuantity, sizes })
    }

    return choices > maximumOptionChoices ? { error: `A product can have at most ${maximumOptionChoices} things to choose between in total` } : options
}

function choiceTitle(title: string, option: string, size: string | null): string {
    return `${title} — ${option}${size ? ` / ${size}` : ""}`
}

function choiceKey(option: string, size: string | null): string {
    return `${option.toLowerCase()}\u0000${(size ?? "").toLowerCase()}`
}

type ParentFields = { id: number; userId: number; title: string; description: string; category: string; imageUrl: string }

// Makes the stored options match the list given: choices that are new are created, ones that match (by name) are
// updated, and ones that are missing are deleted, or hidden when a cart, checkout or order refers to them. Shoppers'
// carts lose the choices that are removed.
// A draft's options are made hidden with it (hiddenAt is the draft's archivedAt) and go on sale when it is published.
export async function syncListingOptions(tx: Prisma.TransactionClient, parent: ParentFields, options: OptionInput[], hiddenAt: Date | null = null): Promise<void> {
    await tx.$executeRaw`SELECT id FROM "Listing" WHERE id = ${parent.id} FOR UPDATE`
    const now = new Date()
    const existing = await tx.listing.findMany({ where: { parentId: parent.id } })
    const byKey = new Map(existing.map((row) => [choiceKey(row.optionLabel ?? "", row.sizeLabel), row]))
    const kept = new Set<number>()

    for (const [optionIndex, option] of options.entries()) {
        const choices = option.sizes.length > 0
            ? option.sizes.map((size) => ({ size: size.label as string | null, stockQuantity: size.stockQuantity }))
            : [{ size: null as string | null, stockQuantity: option.stockQuantity ?? 0 }]

        for (const [sizeIndex, choice] of choices.entries()) {
            const data = {
                title: choiceTitle(parent.title, option.label, choice.size),
                description: parent.description,
                category: parent.category,
                price: option.price,
                stockQuantity: choice.stockQuantity,
                imageUrl: option.imageUrl ?? parent.imageUrl,
                optionLabel: option.label,
                sizeLabel: choice.size,
                position: optionIndex * 1000 + sizeIndex,
                archivedAt: hiddenAt
            }
            const row = byKey.get(choiceKey(option.label, choice.size))

            if (!row) {
                const created = await tx.listing.create({ data: { ...data, userId: parent.userId, parentId: parent.id } })
                kept.add(created.id)
                continue
            }

            kept.add(row.id)

            if (choice.stockQuantity < row.stockQuantity) {
                const reserved = await tx.inventoryReservation.aggregate({
                    where: { listingId: row.id, OR: heldReservationConditions(now) },
                    _sum: { quantity: true }
                })

                if (choice.stockQuantity < (reserved._sum.quantity ?? 0)) {
                    throw new ReservedStockConflict(reserved._sum.quantity ?? 0, choice.size ? `${option.label} / ${choice.size}` : option.label)
                }
            }

            await tx.listing.update({ where: { id: row.id }, data })
        }
    }

    for (const row of existing) {
        if (kept.has(row.id)) {
            continue
        }

        await tx.cartItem.deleteMany({ where: { listingId: row.id } })
        const [orders, checkouts, reservations] = await Promise.all([
            tx.orderItem.count({ where: { listingId: row.id } }),
            tx.checkoutItem.count({ where: { listingId: row.id } }),
            tx.inventoryReservation.count({ where: { listingId: row.id } })
        ])

        if (orders + checkouts + reservations === 0) {
            await tx.listing.delete({ where: { id: row.id } })
        } else if (!row.archivedAt) {
            await tx.listing.update({ where: { id: row.id }, data: { archivedAt: now } })
        }
    }

    // The product itself shows the lowest price; it is never bought, so its own stock stays zero.
    const prices = options.map((option) => option.price)
    await tx.listing.update({ where: { id: parent.id }, data: { stockQuantity: 0, ...(prices.length > 0 ? { price: Math.min(...prices) } : {}) } })
}

// ---- reading ----

export type ChoiceRow = {
    id: number
    parentId: number | null
    optionLabel: string | null
    sizeLabel: string | null
    price: number
    stockQuantity: number
    imageUrl: string
    lowStockThreshold: number | null
}

// A product's current choices: the ones on sale, or all of a draft's (they are hidden with it until it is published).
// Choices a seller removed but that order history still needs are archived on a product that is not a draft.
export const currentChoices = { OR: [{ archivedAt: null }, { parent: { isDraft: true } }] } satisfies Prisma.ListingWhereInput

// The choices on sale for each of the given products (only products that have options appear in the map).
export async function loadChoices(parentIds: number[]): Promise<Map<number, ChoiceRow[]>> {
    const result = new Map<number, ChoiceRow[]>()

    if (parentIds.length === 0) {
        return result
    }

    const rows = await prisma.listing.findMany({
        where: { parentId: { in: parentIds }, ...currentChoices },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { id: true, parentId: true, optionLabel: true, sizeLabel: true, price: true, stockQuantity: true, imageUrl: true, lowStockThreshold: true }
    })

    for (const row of rows) {
        const list = result.get(row.parentId!) ?? []
        list.push(row)
        result.set(row.parentId!, list)
    }

    return result
}

// What a card needs: whether the product has options, the lowest price, and how many are left in total.
export function withOptionSummary<T extends { price: number; stockQuantity: number }>(listing: T, choices: ChoiceRow[] | undefined) {
    if (!choices || choices.length === 0) {
        return { ...listing, hasOptions: false as const, hasPriceRange: false }
    }

    const prices = choices.map((choice) => choice.price)

    return {
        ...listing,
        hasOptions: true as const,
        price: Math.min(...prices),
        hasPriceRange: Math.min(...prices) !== Math.max(...prices),
        stockQuantity: choices.reduce((total, choice) => total + choice.stockQuantity, 0)
    }
}

// The options as the product page needs them. listingId is what goes in the cart (the option itself when it has
// no sizes, otherwise each size).
export function optionTree(choices: ChoiceRow[] | undefined) {
    const tree: Array<{
        label: string
        price: number
        imageUrl: string
        listingId: number | null
        stockQuantity: number | null
        sizes: Array<{ label: string; listingId: number; stockQuantity: number }>
    }> = []

    for (const choice of choices ?? []) {
        let option = tree.find((item) => item.label === choice.optionLabel)

        if (!option) {
            option = { label: choice.optionLabel ?? "", price: choice.price, imageUrl: choice.imageUrl, listingId: null, stockQuantity: null, sizes: [] }
            tree.push(option)
        }

        if (choice.sizeLabel === null) {
            option.listingId = choice.id
            option.stockQuantity = choice.stockQuantity
        } else {
            option.sizes.push({ label: choice.sizeLabel, listingId: choice.id, stockQuantity: choice.stockQuantity })
        }
    }

    return tree
}

// When the product's title, description, category or main photo changes, its choices follow: their titles are built
// from the product's, and a choice without a photo of its own shows the product's main photo.
export async function propagateToOptions(
    tx: Prisma.TransactionClient,
    before: { imageUrl: string },
    after: { id: number; title: string; description: string; category: string; imageUrl: string }
): Promise<void> {
    const choices = await tx.listing.findMany({ where: { parentId: after.id }, select: { id: true, optionLabel: true, sizeLabel: true, imageUrl: true } })

    for (const choice of choices) {
        await tx.listing.update({
            where: { id: choice.id },
            data: {
                title: choiceTitle(after.title, choice.optionLabel ?? "", choice.sizeLabel),
                description: after.description,
                category: after.category,
                ...(choice.imageUrl === before.imageUrl ? { imageUrl: after.imageUrl } : {})
            }
        })
    }
}

// How many choices a product has on sale; zero for an ordinary listing.
export async function countChoices(parentId: number): Promise<number> {
    return prisma.listing.count({ where: { parentId, ...currentChoices } })
}
