import { isHttpsUrl } from "./inputRules.js"
import { averageRating } from "./reviews.js"

// A listing has up to five photos. The first is the one cards show; Listing.imageUrl always holds it, so
// everything that only needs one picture (cards, carts, order history) keeps working.
export const maximumListingImages = 5

// Add this to a listing query to load the photos in order.
export const imagesInclude = { orderBy: { position: "asc" as const }, select: { url: true } }

// The photos from a request body: `imageUrls` (an ordered list), or the older single `imageUrl`.
// Undefined when the request does not mention photos; otherwise the list of links, or the problem.
export function readListingImages(body: { imageUrls?: unknown; imageUrl?: unknown }): string[] | { error: string } | undefined {
    if (body.imageUrls !== undefined) {
        if (!Array.isArray(body.imageUrls) || body.imageUrls.length < 1 || body.imageUrls.length > maximumListingImages) {
            return { error: `Add between 1 and ${maximumListingImages} photos` }
        }

        if (!body.imageUrls.every((url) => isHttpsUrl(url))) {
            return { error: "Photos must be https links" }
        }

        const urls = body.imageUrls as string[]

        if (new Set(urls).size !== urls.length) {
            return { error: "Each photo can only be added once" }
        }

        return urls
    }

    if (body.imageUrl !== undefined) {
        return isHttpsUrl(body.imageUrl) ? [body.imageUrl] : { error: "Image URL must be an https link" }
    }

    return undefined
}

// A listing as the API returns it: the photos as a plain ordered list of links in `images` (a listing saved
// before photos existed has none stored, so it falls back to its one `imageUrl`), and its star rating as
// `ratingAverage` (one decimal, null until it has a review) next to `ratingCount`.
export function withImages<T extends { imageUrl: string; images: Array<{ url: string }>; ratingSum: number; ratingCount: number }>(
    listing: T
): Omit<T, "images" | "ratingSum"> & { images: string[]; ratingAverage: number | null } {
    const { images, ratingSum, ...rest } = listing
    return {
        ...rest,
        images: images.length > 0 ? images.map((image) => image.url) : [listing.imageUrl],
        ratingAverage: averageRating(ratingSum, listing.ratingCount)
    }
}
