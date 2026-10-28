import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma } from "../generated/prisma/client.js"
import { getCanonicalCategory } from "../lib/categories.js"
import { priceProblem } from "../lib/inputRules.js"
import { heldReservationConditions } from "../lib/inventoryReservations.js"
import { currentChoices, propagateToOptions } from "../lib/listingOptions.js"
import { lowStockThresholdProblem, parseLowStockThreshold } from "../lib/stockAlerts.js"
import { listingTextProblem, stockProblem } from "./listingController.js"

// One screen to change many products and options at once: after a restock, when prices go up, or to finish products
// added from photos. Every change is checked first and nothing is saved unless all of them are fine, so the screen
// never ends up half saved. A product with options is priced and stocked on its options; an option only has its own
// price, stock and low-stock number (its name, description and category come from its product). Sizes share their
// option's price, so a new price on one size goes to every size of that option, and the product's "from" price follows.
export const maximumBulkChanges = 200

type BulkProblem = { listingId: number | null; field: string | null; message: string }
type BulkChange = {
    listingId: number
    price?: number
    stockQuantity?: number
    title?: string
    description?: string
    category?: string
    lowStockThreshold?: number | null
}

const fields = ["price", "stockQuantity", "title", "description", "category", "lowStockThreshold"] as const

function readChanges(value: unknown): { changes: BulkChange[]; problems: BulkProblem[] } | { error: string } {
    if (!Array.isArray(value) || value.length === 0 || value.length > maximumBulkChanges) {
        return { error: `Send between 1 and ${maximumBulkChanges} changes in changes` }
    }

    const changes: BulkChange[] = []
    const problems: BulkProblem[] = []
    const seen = new Set<number>()

    for (const entry of value as Array<Record<string, unknown> | null>) {
        const listingId = typeof entry === "object" && entry !== null && Number.isSafeInteger(entry.listingId) && (entry.listingId as number) > 0 ? entry.listingId as number : null

        if (listingId === null) {
            problems.push({ listingId: null, field: "listingId", message: "Each change needs a listingId" })
            continue
        }

        if (seen.has(listingId)) {
            problems.push({ listingId, field: "listingId", message: "This product is in the list twice" })
            continue
        }

        seen.add(listingId)
        const input = entry!
        const change: BulkChange = { listingId }
        const problem = (field: string, message: string) => problems.push({ listingId, field, message })

        if (!fields.some((field) => input[field] !== undefined)) {
            problem("listingId", "Nothing to change")
            continue
        }

        if (input.price !== undefined) {
            const error = priceProblem(input.price)
            error ? problem("price", error) : change.price = Number(input.price)
        }

        if (input.stockQuantity !== undefined) {
            const error = stockProblem(input.stockQuantity)
            error ? problem("stockQuantity", error) : change.stockQuantity = input.stockQuantity as number
        }

        for (const field of ["title", "description"] as const) {
            if (input[field] !== undefined) {
                const text = typeof input[field] === "string" ? (input[field] as string).trim() : null
                const error = text === null || text === "" ? `Add a ${field}` : listingTextProblem({ [field]: text })
                error ? problem(field, error) : change[field] = text!
            }
        }

        if (input.category !== undefined) {
            const category = getCanonicalCategory(input.category)
            category ? change.category = category : problem("category", "Category is not valid")
        }

        if (input.lowStockThreshold !== undefined) {
            const threshold = parseLowStockThreshold(input.lowStockThreshold, true)
            threshold === "invalid" ? problem("lowStockThreshold", lowStockThresholdProblem) : change.lowStockThreshold = threshold ?? null
        }

        changes.push(change)
    }

    return { changes, problems }
}

class ReservedStockProblems extends Error {
    constructor(readonly problems: BulkProblem[]) {
        super("Stock below reserved")
    }
}

export const bulkUpdateListings = async (req: Request, res: Response) => {
    const sellerId = req.user!.id
    const read = readChanges(req.body.changes)

    if ("error" in read) {
        res.status(400).send({ message: read.error })
        return
    }

    const ids = read.changes.map((change) => change.listingId)
    const [listings, choiceCounts] = await Promise.all([
        prisma.listing.findMany({ where: { id: { in: ids }, userId: sellerId } }),
        prisma.listing.groupBy({ by: ["parentId"], where: { parentId: { in: ids }, ...currentChoices }, _count: { _all: true } })
    ])
    const byId = new Map(listings.map((listing) => [listing.id, listing]))
    const hasOptions = new Set(choiceCounts.map((group) => group.parentId))
    const problems = [...read.problems]

    for (const change of read.changes) {
        const listing = byId.get(change.listingId)
        const problem = (field: string, message: string) => problems.push({ listingId: change.listingId, field, message })

        // Someone else's product looks the same as one that does not exist.
        if (!listing) {
            problem("listingId", "Product not found")
            continue
        }

        if (listing.parentId !== null) {
            for (const field of ["title", "description", "category"] as const) {
                if (change[field] !== undefined) {
                    problem(field, "This is one option of a product. Change its name, description and category on the product")
                }
            }
        } else if (hasOptions.has(listing.id)) {
            for (const field of ["price", "stockQuantity"] as const) {
                if (change[field] !== undefined) {
                    problem(field, "This product has options. Change price and stock on each option")
                }
            }
        }
    }

    // Two sizes of one option given different prices cannot both be kept.
    const sizePrices = new Map<string, number>()

    for (const change of read.changes) {
        const listing = byId.get(change.listingId)

        if (change.price === undefined || !listing || listing.parentId === null || listing.sizeLabel === null) {
            continue
        }

        const key = `${listing.parentId}:${listing.optionLabel ?? ""}`
        const earlier = sizePrices.get(key)

        if (earlier !== undefined && earlier !== change.price) {
            problems.push({ listingId: change.listingId, field: "price", message: `All sizes of "${listing.optionLabel}" share one price` })
        }

        sizePrices.set(key, change.price)
    }

    if (problems.length > 0) {
        res.status(400).send({
            message: `Nothing was saved. Fix ${problems.length === 1 ? "this problem" : `these ${problems.length} problems`} and try again`,
            code: "BULK_INVALID",
            problems
        })
        return
    }

    try {
        const updated = await prisma.$transaction(async (tx) => {
            const now = new Date()
            const stockChanges = read.changes.filter((change) => change.stockQuantity !== undefined)
            // Stock cannot go below what shoppers are paying for right now.
            const reserved = stockChanges.length === 0 ? [] : await tx.inventoryReservation.groupBy({
                by: ["listingId"],
                where: { listingId: { in: stockChanges.map((change) => change.listingId) }, OR: heldReservationConditions(now) },
                _sum: { quantity: true }
            })
            const reservedProblems = stockChanges.flatMap((change) => {
                const held = reserved.find((group) => group.listingId === change.listingId)?._sum.quantity ?? 0
                return change.stockQuantity! < held
                    ? [{ listingId: change.listingId, field: "stockQuantity", message: `Stock cannot be less than ${held}: shoppers are paying for them right now` }]
                    : []
            })

            if (reservedProblems.length > 0) {
                throw new ReservedStockProblems(reservedProblems)
            }

            const results = []

            for (const { listingId, ...data } of read.changes) {
                const before = byId.get(listingId)!
                const after = await tx.listing.update({ where: { id: listingId }, data })

                // A product's name, description and category are shown on its options too.
                if (hasOptions.has(listingId) && (data.title !== undefined || data.description !== undefined || data.category !== undefined)) {
                    await propagateToOptions(tx, before, after)
                }

                // Every size of an option has the option's price.
                if (data.price !== undefined && before.parentId !== null && before.sizeLabel !== null) {
                    await tx.listing.updateMany({
                        where: { parentId: before.parentId, optionLabel: before.optionLabel, id: { not: listingId }, ...currentChoices },
                        data: { price: data.price }
                    })
                }

                results.push(after)
            }

            // A product with options shows the lowest price of its options.
            const repriced = [...new Set(read.changes
                .filter((change) => change.price !== undefined)
                .map((change) => byId.get(change.listingId)!.parentId)
                .filter((id): id is number => id !== null))]

            for (const parentId of repriced) {
                const lowest = await tx.listing.aggregate({ where: { parentId, ...currentChoices }, _min: { price: true } })

                if (lowest._min.price !== null) {
                    await tx.listing.update({ where: { id: parentId }, data: { price: lowest._min.price } })
                }
            }

            return results
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

        res.send({
            count: updated.length,
            listings: updated.map((listing) => ({
                listingId: listing.id,
                title: listing.title,
                description: listing.description,
                price: listing.price,
                stockQuantity: listing.stockQuantity,
                category: listing.category,
                lowStockThreshold: listing.lowStockThreshold
            }))
        })
    } catch (error) {
        if (error instanceof ReservedStockProblems) {
            res.status(409).send({ message: "Nothing was saved. Some stock is lower than what shoppers are paying for", code: "BULK_STOCK_RESERVED", problems: error.problems })
            return
        }

        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
            res.status(409).send({ message: "Stock changed while saving. Please try again" })
            return
        }

        throw error
    }
}
