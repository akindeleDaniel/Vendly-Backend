// Limits on what sellers can store, so a single request cannot fill the database or the pages that show it.

export const maximumListingTitleLength = 120
export const maximumListingDescriptionLength = 5000
export const maximumBusinessNameLength = 80
export const maximumUrlLength = 2048
export const maximumListingPrice = 100_000_000
export const maximumStockQuantity = 1_000_000

// Images are uploaded by the frontend and referred to by https link; anything else (javascript:, data:, plain
// http, a link to a local address) is refused because the pages would load or follow it.
export function isHttpsUrl(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumUrlLength) {
        return false
    }

    try {
        const url = new URL(value)
        return url.protocol === "https:" && url.hostname.includes(".") && !url.username && !url.password
    } catch {
        return false
    }
}

// A price in naira: a number or numeric text, above 0, with at most two decimals, and a sane maximum.
export function priceProblem(price: unknown): string | null {
    const amount = typeof price === "string" ? Number(price.trim()) : price

    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        return "Price must be a number greater than 0"
    }

    if (amount > maximumListingPrice) {
        return `Price cannot be more than ${maximumListingPrice.toLocaleString("en-NG")}`
    }

    // Whole kobo only. The small tolerance absorbs the way decimals are stored (19.99 * 100 is 1998.9999999999998).
    if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
        return "Price can have at most two decimal places"
    }

    return null
}
