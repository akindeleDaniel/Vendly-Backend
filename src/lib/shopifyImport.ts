import { isHttpsUrl, maximumListingDescriptionLength, priceProblem } from "./inputRules.js"
import { maximumListingImages } from "./listingImages.js"
import { readOptions, type OptionInput } from "./listingOptions.js"

// Reading a Shopify product export (Products > Export > CSV) as it is, so a seller moving from Shopify uploads that
// file unchanged. Shopify writes one row per variant and per extra image, grouped by "Handle"; each handle becomes one
// product. Option 1 becomes the option and Options 2 and 3 the size, as StoreHatch prices each option, not each size.
// When a product's sizes have different prices, each variant becomes an option of its own ("Blue / M"), so no price
// is ever wrong. Products come in as drafts: Shopify's categories are not StoreHatch's, and newer exports may not
// carry stock, so the seller checks them and publishes.

export type ImportProblem = { row: number; column: string | null; message: string }

export type ShopifyProduct = {
    row: number
    title: string
    description: string
    price: number
    stockQuantity: number
    imageUrls: string[]
    options: OptionInput[]
}

export function isShopifyExport(header: string[]): boolean {
    const names = header.map((name) => name.trim().toLowerCase())
    return names.includes("handle") && names.includes("variant price")
}

// Shopify descriptions are HTML: keep the words and the line breaks, drop the markup.
export function htmlToText(html: string): string {
    return html
        .replace(/<\s*br\s*\/?>/gi, "\n")
        .replace(/<\s*li[^>]*>/gi, "\n• ")
        .replace(/<\/\s*(p|div|li|h[1-6]|tr|ul|ol)\s*>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim()
}

type Variant = { option1: string; option2: string; option3: string; price: number; stockQuantity: number; imageUrl: string }

export function readShopifyExport(rows: string[][], maximumProducts: number):
    { products: ShopifyProduct[]; problems: ImportProblem[]; warnings: ImportProblem[] } | { error: string } {
    const [header = [], ...lines] = rows
    const names = header.map((name) => name.trim().toLowerCase())
    const at = (cells: string[], name: string) => (cells[names.indexOf(name)] ?? "").trim()
    const hasStock = names.includes("variant inventory qty")

    // Rows grouped by handle, in the order the file has them; row numbers match the spreadsheet's.
    const groups = new Map<string, Array<{ cells: string[]; row: number }>>()

    for (const [index, cells] of lines.entries()) {
        const handle = at(cells, "handle")

        if (handle !== "") {
            groups.set(handle, [...(groups.get(handle) ?? []), { cells, row: index + 2 }])
        }
    }

    if (groups.size === 0) {
        return { error: "The file has no products in it" }
    }

    const problems: ImportProblem[] = []
    const warnings: ImportProblem[] = []
    const products: ShopifyProduct[] = []

    if (!hasStock) {
        warnings.push({ row: 1, column: null, message: "This file has no stock numbers (newer Shopify exports keep them separately). Stock is set to 0: add it before publishing" })
    }

    for (const group of groups.values()) {
        const first = group.find(({ cells }) => at(cells, "title") !== "") ?? group[0]!
        const row = first.row
        const problem = (column: string | null, message: string) => problems.push({ row, column, message })
        const warn = (column: string | null, message: string) => warnings.push({ row, column, message })

        if (at(first.cells, "gift card").toLowerCase() === "true") {
            warn(null, "Gift cards are not imported")
            continue
        }

        const title = at(first.cells, "title").replace(/\s+/g, " ")

        if (title === "") {
            problem("Title", "Add a title")
        } else if (title.length > 120) {
            problem("Title", "Title must be 120 characters or fewer")
        }

        let description = htmlToText(at(first.cells, "body (html)"))

        if (description.length > maximumListingDescriptionLength) {
            description = description.slice(0, maximumListingDescriptionLength).trimEnd()
            warn("Body (HTML)", `Description cut to ${maximumListingDescriptionLength} characters`)
        }

        // Product photos, in Shopify's order.
        const images = group
            .map(({ cells }, index) => ({ src: at(cells, "image src"), position: Number(at(cells, "image position")) || 1000 + index }))
            .filter((image) => image.src !== "")
            .sort((left, right) => left.position - right.position)
            .map((image) => image.src)
            .filter((src, index, all) => all.indexOf(src) === index)

        if (images.some((src) => !isHttpsUrl(src))) {
            problem("Image Src", "Photo links must start with https://")
        }

        if (images.length > maximumListingImages) {
            warn("Image Src", `Only the first ${maximumListingImages} photos are kept`)
        }

        if (images.length === 0) {
            warn("Image Src", "No photo: add one before publishing")
        }

        // Variants: the rows with a price.
        const variants: Variant[] = []

        for (const { cells, row: variantRow } of group) {
            const priceText = at(cells, "variant price").replace(/,/g, "")

            if (priceText === "") {
                continue
            }

            const price = Number(priceText)
            const priceError = priceProblem(price)

            if (priceError) {
                problems.push({ row: variantRow, column: "Variant Price", message: priceError })
                continue
            }

            const quantityText = at(cells, "variant inventory qty")
            let stockQuantity = 0

            if (quantityText !== "") {
                const quantity = Number(quantityText)

                if (!Number.isInteger(quantity)) {
                    problems.push({ row: variantRow, column: "Variant Inventory Qty", message: "Stock must be a whole number" })
                    continue
                }

                // Shopify allows selling below zero; StoreHatch does not.
                stockQuantity = Math.max(quantity, 0)

                if (quantity < 0) {
                    warnings.push({ row: variantRow, column: "Variant Inventory Qty", message: "Stock below zero was set to 0" })
                }
            }

            variants.push({
                option1: at(cells, "option1 value"),
                option2: at(cells, "option2 value"),
                option3: at(cells, "option3 value"),
                price,
                stockQuantity,
                imageUrl: at(cells, "variant image")
            })
        }

        if (variants.length === 0) {
            problem("Variant Price", "No price found for this product")
            continue
        }

        const simple = variants.length === 1 && (variants[0]!.option1 === "" || variants[0]!.option1 === "Default Title")
        let options: OptionInput[] = []

        if (!simple) {
            const sizeOf = (variant: Variant) => [variant.option2, variant.option3].filter(Boolean).join(" / ")
            const byOption = new Map<string, Variant[]>()

            for (const variant of variants) {
                byOption.set(variant.option1, [...(byOption.get(variant.option1) ?? []), variant])
            }

            const pricedBySize = [...byOption.values()].some((group) => new Set(group.map((variant) => variant.price)).size > 1)
            const photo = (url: string) => (url !== "" && isHttpsUrl(url) ? url : null)
            const raw = pricedBySize || variants.every((variant) => sizeOf(variant) === "")
                ? variants.map((variant) => ({
                    label: [variant.option1, variant.option2, variant.option3].filter(Boolean).join(" / "),
                    price: variant.price,
                    imageUrl: photo(variant.imageUrl),
                    stockQuantity: variant.stockQuantity
                }))
                : [...byOption.entries()].map(([label, group]) => ({
                    label,
                    price: group[0]!.price,
                    imageUrl: photo(group.find((variant) => variant.imageUrl !== "")?.imageUrl ?? ""),
                    sizes: group.map((variant) => ({ label: sizeOf(variant), stockQuantity: variant.stockQuantity }))
                }))
            const read = readOptions(raw, variants[0]!.price)

            if ("error" in read) {
                problem("Option1 Value", read.error)
                continue
            }

            options = read
        }

        products.push({
            row,
            title,
            description,
            price: Math.min(...variants.map((variant) => variant.price)),
            stockQuantity: simple ? variants[0]!.stockQuantity : 0,
            imageUrls: images.slice(0, maximumListingImages),
            options
        })
    }

    if (products.length > maximumProducts) {
        return { error: `Import at most ${maximumProducts} products at a time (this file has ${products.length})` }
    }

    return { products, problems, warnings }
}
