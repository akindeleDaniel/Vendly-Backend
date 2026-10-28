import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { categories, getCanonicalCategory } from "../lib/categories.js"
import { csvCell, parseCsv } from "../lib/csv.js"
import { isHttpsUrl, priceProblem } from "../lib/inputRules.js"
import { maximumListingImages } from "../lib/listingImages.js"
import { listingTextProblem, stockProblem } from "./listingController.js"
import { syncListingOptions } from "../lib/listingOptions.js"
import { isShopifyExport, readShopifyExport, type ShopifyProduct } from "../lib/shopifyImport.js"

// Adding many products at once from a spreadsheet saved as CSV. Every row is checked with the same rules as adding
// one product; if any row has a problem, nothing is saved and every problem is listed with its row and column, so
// the seller fixes the file and tries again. A dry run checks the file without saving. Options (sizes, colours) are
// added on each product afterwards.
export const maximumImportRows = 200
// Shopify exports carry HTML descriptions and a row per variant and photo, so files can be large.
export const maximumImportCharacters = 1_500_000

const photoColumns = Array.from({ length: maximumListingImages }, (_, index) => `photo_${index + 1}`)
const requiredColumns = ["title", "description", "price", "stock", "category", "photo_1"]
const knownColumns = new Set([...requiredColumns, ...photoColumns])

type ImportProblem = { row: number; column: string | null; message: string }
type ImportedProduct = { row: number; title: string; description: string; price: number; stockQuantity: number; category: string; imageUrls: string[] }

// "Price", "photo 1" and "Photo_1" all mean the same column.
function columnKey(header: string): string {
    return header.trim().toLowerCase().replace(/[\s-]+/g, "_")
}

// Sellers write prices the way they say them: "₦15,000", "15000" or "15,000.50".
function readPrice(value: string): number | string {
    const cleaned = value.replace(/[₦,\s]/g, "").replace(/^ngn/i, "")
    return cleaned === "" ? "" : Number.isFinite(Number(cleaned)) ? Number(cleaned) : value
}

function readStock(value: string): number | string {
    const cleaned = value.replace(/[,\s]/g, "")
    return /^\d+$/.test(cleaned) ? Number(cleaned) : value
}

function readFile(csv: unknown): { products: ImportedProduct[]; problems: ImportProblem[] } | { error: string } {
    if (typeof csv !== "string" || csv.trim().length === 0) {
        return { error: "Send the spreadsheet as CSV text in csv" }
    }

    if (csv.length > maximumImportCharacters) {
        return { error: `The file is too big. Import at most ${maximumImportRows} products at a time` }
    }

    const rows = parseCsv(csv)

    if (!rows) {
        return { error: "The file could not be read: a quote mark is not closed. Save it again as CSV from Excel or Google Sheets" }
    }

    const [header = [], ...lines] = rows
    const keys = header.map(columnKey)
    const problems: ImportProblem[] = []

    for (const [index, key] of keys.entries()) {
        if (key !== "" && !knownColumns.has(key)) {
            problems.push({ row: 1, column: header[index]!.trim(), message: `Unknown column. Use: ${requiredColumns.join(", ")} and up to ${photoColumns.at(-1)}` })
        }
    }

    for (const column of requiredColumns) {
        if (!keys.includes(column)) {
            problems.push({ row: 1, column, message: "This column is missing" })
        }
    }

    if (problems.length > 0) {
        return { products: [], problems }
    }

    // Blank lines (often left at the end by spreadsheets) are skipped; row numbers match the spreadsheet's.
    const filled = lines.map((cells, index) => ({ cells, row: index + 2 })).filter(({ cells }) => cells.some((cell) => cell.trim() !== ""))

    if (filled.length === 0) {
        return { error: "The file has no products in it" }
    }

    if (filled.length > maximumImportRows) {
        return { error: `Import at most ${maximumImportRows} products at a time (this file has ${filled.length})` }
    }

    const products: ImportedProduct[] = []

    for (const { cells, row } of filled) {
        const value = (column: string) => (cells[keys.indexOf(column)] ?? "").trim()
        const rowProblems: ImportProblem[] = []
        const problem = (column: string, message: string) => rowProblems.push({ row, column, message })

        const title = value("title")
        const description = value("description")
        const category = getCanonicalCategory(value("category"))
        const price = readPrice(value("price"))
        const stock = readStock(value("stock"))
        const imageUrls = photoColumns.map(value).filter((url) => url !== "")

        if (title === "") {
            problem("title", "Add a title")
        }

        if (description === "") {
            problem("description", "Add a description")
        }

        const textProblem = listingTextProblem({ title, description })

        if (textProblem) {
            problem(textProblem.startsWith("Title") ? "title" : "description", textProblem)
        }

        const priceError = price === "" ? "Add a price" : priceProblem(price)

        if (priceError) {
            problem("price", priceError)
        }

        const stockError = stock === "" ? "Add how many are in stock" : stockProblem(stock)

        if (stockError) {
            problem("stock", stockError)
        }

        if (!category) {
            problem("category", value("category") === "" ? "Add a category" : `Not a StoreHatch category. Use one of: ${categories.join(", ")}`)
        }

        if (value("photo_1") === "") {
            problem("photo_1", "Add at least one photo link")
        }

        for (const column of photoColumns) {
            if (value(column) !== "" && !isHttpsUrl(value(column))) {
                problem(column, "Photo links must start with https://")
            }
        }

        if (rowProblems.length > 0) {
            problems.push(...rowProblems)
            continue
        }

        products.push({ row, title, description, price: price as number, stockQuantity: stock as number, category: category!, imageUrls })
    }

    return { products, problems }
}

// Same title as a product already on sale in the shop, or repeated in the file: probably imported twice.
async function findLikelyRepeats(sellerId: number, products: Array<{ row: number; title: string }>) {
    const existing = await prisma.listing.findMany({
        where: { userId: sellerId, parentId: null, archivedAt: null, title: { in: products.map((product) => product.title), mode: "insensitive" } },
        select: { title: true }
    })
    const existingTitles = new Set(existing.map((listing) => listing.title.toLowerCase()))
    const seen = new Map<string, number>()
    const warnings: ImportProblem[] = []

    for (const product of products) {
        const key = product.title.toLowerCase()

        if (existingTitles.has(key)) {
            warnings.push({ row: product.row, column: "title", message: "You already have a product with this title" })
        } else if (seen.has(key)) {
            warnings.push({ row: product.row, column: "title", message: `Same title as row ${seen.get(key)}` })
        }

        seen.set(key, seen.get(key) ?? product.row)
    }

    return warnings
}

export const importListings = async (req: Request, res: Response) => {
    const sellerId = req.user!.id
    const dryRun = req.body.dryRun === true

    // A Shopify product export is recognised by its columns and read as it is.
    if (typeof req.body.csv === "string" && req.body.csv.length <= maximumImportCharacters) {
        const rows = parseCsv(req.body.csv)

        if (rows && isShopifyExport(rows[0] ?? [])) {
            await importShopify(req, res, rows, dryRun)
            return
        }
    }

    const read = readFile(req.body.csv)

    if ("error" in read) {
        res.status(400).send({ message: read.error })
        return
    }

    if (read.problems.length > 0) {
        sendProblems(res, read.problems)
        return
    }

    const profile = await prisma.sellerProfile.findUnique({ where: { userId: sellerId }, select: { id: true } })

    if (!profile) {
        res.status(400).send({ message: "Set up your store before creating a listing" })
        return
    }

    const warnings = await findLikelyRepeats(sellerId, read.products)

    if (dryRun) {
        res.send({
            dryRun: true,
            count: read.products.length,
            products: read.products.map(({ row, title, price, stockQuantity, category, imageUrls }) => ({ row, title, price, stockQuantity, category, imageUrl: imageUrls[0], photos: imageUrls.length })),
            warnings
        })
        return
    }

    // All or nothing.
    const created = await prisma.$transaction(async (tx) => {
        const listings = []

        for (const product of read.products) {
            listings.push(await tx.listing.create({
                data: {
                    userId: sellerId,
                    title: product.title,
                    description: product.description,
                    price: product.price,
                    category: product.category,
                    imageUrl: product.imageUrls[0]!,
                    stockQuantity: product.stockQuantity,
                    images: { create: product.imageUrls.map((url, position) => ({ url, position })) }
                },
                select: { id: true, title: true }
            }))
        }

        return listings
    })

    res.status(201).send({ count: created.length, listings: created, warnings })
}

function sendProblems(res: Response, problems: ImportProblem[]) {
    res.status(400).send({
        message: `Nothing was imported. Fix ${problems.length === 1 ? "this problem" : `these ${problems.length} problems`} and try again`,
        code: "IMPORT_INVALID",
        problems
    })
}

// Shopify products come in as drafts, with their options hidden with them: the seller chooses a StoreHatch category,
// checks stock and publishes (POST /listings/drafts/publish). All or nothing, like the StoreHatch template.
async function importShopify(req: Request, res: Response, rows: string[][], dryRun: boolean) {
    const sellerId = req.user!.id
    const read = readShopifyExport(rows, maximumImportRows)

    if ("error" in read) {
        res.status(400).send({ message: read.error })
        return
    }

    if (read.problems.length > 0) {
        sendProblems(res, read.problems)
        return
    }

    if (read.products.length === 0) {
        res.status(400).send({ message: "The file has no products that can be imported" })
        return
    }

    const profile = await prisma.sellerProfile.findUnique({ where: { userId: sellerId }, select: { id: true } })

    if (!profile) {
        res.status(400).send({ message: "Set up your store before creating a listing" })
        return
    }

    const warnings = [...read.warnings, ...(await findLikelyRepeats(sellerId, read.products))]
    const summary = (product: ShopifyProduct) => ({
        row: product.row,
        title: product.title,
        price: product.price,
        stockQuantity: product.stockQuantity,
        imageUrl: product.imageUrls[0] ?? null,
        photos: product.imageUrls.length,
        options: product.options.reduce((count, option) => count + Math.max(option.sizes.length, 1), 0)
    })

    if (dryRun) {
        res.send({ dryRun: true, source: "shopify", asDrafts: true, count: read.products.length, products: read.products.map(summary), warnings })
        return
    }

    const now = new Date()
    const created = await prisma.$transaction(async (tx) => {
        const drafts = []

        for (const product of read.products) {
            const draft = await tx.listing.create({
                data: {
                    userId: sellerId,
                    title: product.title,
                    description: product.description,
                    price: product.price,
                    stockQuantity: product.stockQuantity,
                    category: "",
                    imageUrl: product.imageUrls[0] ?? "",
                    archivedAt: now,
                    isDraft: true,
                    images: { create: product.imageUrls.map((url, position) => ({ url, position })) }
                }
            })

            if (product.options.length > 0) {
                await syncListingOptions(tx, draft, product.options, now)
            }

            drafts.push({ listingId: draft.id, title: draft.title })
        }

        return drafts
    }, { timeout: 60_000 })

    res.status(201).send({ source: "shopify", asDrafts: true, count: created.length, drafts: created, warnings })
}

// A file to fill in: the column names and one example row.
export const importTemplate = (_req: Request, res: Response) => {
    const header = [...requiredColumns, ...photoColumns.slice(1)]
    const example = [
        "Two-piece ankara set", "Cotton ankara top and trousers. Sizes S to XL.", "15000", "10", "Fashion & Clothing",
        "https://res.cloudinary.com/your-cloud/image/upload/ankara-front.jpg", "https://res.cloudinary.com/your-cloud/image/upload/ankara-back.jpg",
        ...photoColumns.slice(2).map(() => "")
    ]
    const csv = "﻿" + [header, example].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n"

    res.attachment("storehatch-products-template.csv").type("text/csv; charset=utf-8").send(csv)
}
