import prisma from "./prisma.js"

// Housekeeping that nobody asks for: leftovers no one needs any more are removed so the database stays small and
// the free Cloudinary plan lasts. Runs with the other background checks. Nothing here touches anything that money
// moved through, or anything a person still uses.
const dayMs = 24 * 60 * 60 * 1000
export const abandonedCheckoutDays = 30
export const paymentEventDays = 90
export const unusedPhotoDays = 7
const batchSize = 200

// Checkouts that were started and never paid, a month on: no successful payment, and none still waiting for an
// answer. Their held stock, unpaid orders and failed payment tries go with them.
export async function purgeAbandonedCheckouts(now = new Date()): Promise<number> {
    const abandoned = await prisma.checkout.findMany({
        where: {
            createdAt: { lt: new Date(now.getTime() - abandonedCheckoutDays * dayMs) },
            status: { not: "COMPLETED" },
            paymentAttempts: { none: { status: { in: ["SUCCESS", "PENDING"] } } },
            orders: { every: { status: { in: ["PENDING_PAYMENT", "CANCELLED"] } } }
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: batchSize
    })
    const ids = abandoned.map((checkout) => checkout.id)

    if (ids.length === 0) {
        return 0
    }

    await prisma.$transaction([
        // A month on, with no payment waiting, every stock hold of these checkouts has long expired.
        prisma.inventoryReservation.deleteMany({ where: { checkoutId: { in: ids } } }),
        prisma.checkoutItem.deleteMany({ where: { checkoutId: { in: ids } } }),
        prisma.orderItem.deleteMany({ where: { order: { checkoutId: { in: ids } } } }),
        prisma.order.deleteMany({ where: { checkoutId: { in: ids } } }),
        prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: ids }, status: "FAILED" } }),
        prisma.checkout.deleteMany({ where: { id: { in: ids } } })
    ])

    return ids.length
}

// The log of payment provider notifications, kept to spot duplicates. Providers only resend for a few days.
export async function purgeOldPaymentEvents(now = new Date()): Promise<number> {
    const result = await prisma.paymentEvent.deleteMany({
        where: { processedAt: { not: null }, receivedAt: { lt: new Date(now.getTime() - paymentEventDays * dayMs) } }
    })
    return result.count
}

// ---- Unused photos on Cloudinary ----
//
// Photos are uploaded straight from the browser before a product (or logo, review, complaint) is saved, so some are
// never used. Once a day, photos older than 7 days that nothing in StoreHatch refers to are deleted. It runs only
// when switched on in the backend .env (CLOUDINARY_CLEANUP=on with the Cloudinary admin keys), and only inside
// CLOUDINARY_CLEANUP_FOLDER when that is set, so it never touches photos of anything else on the same account.

export type CloudinaryPhoto = { publicId: string; createdAt: Date }

export interface CloudinaryAdmin {
    listPhotos(cursor: string | null): Promise<{ photos: CloudinaryPhoto[]; nextCursor: string | null }>
    deletePhotos(publicIds: string[]): Promise<void>
}

let adminForTesting: CloudinaryAdmin | null = null
let lastPhotoCleanupAt = 0

export function setCloudinaryAdminForTesting(admin: CloudinaryAdmin | null): void {
    adminForTesting = admin
    lastPhotoCleanupAt = 0
}

function cloudinarySettings() {
    const env = process.env
    const cloudName = env.CLOUDINARY_CLOUD_NAME?.trim()
    const apiKey = env.CLOUDINARY_API_KEY?.trim()
    const apiSecret = env.CLOUDINARY_API_SECRET?.trim()
    const folder = env.CLOUDINARY_CLEANUP_FOLDER?.trim().replace(/^\/+|\/+$/g, "") || null
    const on = env.CLOUDINARY_CLEANUP?.trim().toLowerCase() === "on"
    return on && cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret, folder } : null
}

// Cloudinary's Admin API: list uploaded images (500 at a time) and delete by id (100 at a time).
function cloudinaryAdmin(settings: NonNullable<ReturnType<typeof cloudinarySettings>>): CloudinaryAdmin {
    const base = `https://api.cloudinary.com/v1_1/${encodeURIComponent(settings.cloudName)}/resources/image/upload`
    const headers = { authorization: `Basic ${Buffer.from(`${settings.apiKey}:${settings.apiSecret}`).toString("base64")}` }

    return {
        async listPhotos(cursor) {
            const query = new URLSearchParams({ max_results: "500" })
            if (settings.folder) query.set("prefix", `${settings.folder}/`)
            if (cursor) query.set("next_cursor", cursor)
            const response = await fetch(`${base}?${query}`, { headers, signal: AbortSignal.timeout(20_000) })

            if (!response.ok) {
                throw new Error(`Cloudinary listing failed with status ${response.status}`)
            }

            const body = await response.json() as { resources?: Array<{ public_id: string; created_at: string }>; next_cursor?: string }
            return {
                photos: (body.resources ?? []).map((resource) => ({ publicId: resource.public_id, createdAt: new Date(resource.created_at) })),
                nextCursor: body.next_cursor ?? null
            }
        },
        async deletePhotos(publicIds) {
            const query = new URLSearchParams()
            publicIds.forEach((id) => query.append("public_ids[]", id))
            const response = await fetch(`${base}?${query}`, { method: "DELETE", headers, signal: AbortSignal.timeout(20_000) })

            if (!response.ok) {
                throw new Error(`Cloudinary delete failed with status ${response.status}`)
            }
        }
    }
}

// The Cloudinary id inside a photo address, for example
// https://res.cloudinary.com/demo/image/upload/c_fill,w_400/v1712/shops/ankara.jpg -> shops/ankara.
export function cloudinaryPublicId(url: string): string | null {
    const match = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(.+)$/.exec(url.split("?")[0] ?? "")

    if (!match) {
        return null
    }

    const parts = match[1]!.split("/")

    // Leading parts that are settings (c_fill,w_400) or the version (v1712) are not part of the id.
    while (parts.length > 1 && (/^v\d+$/.test(parts[0]!) || /^[a-z]{1,3}_[^/]*$/.test(parts[0]!) || parts[0]!.includes(","))) {
        parts.shift()
    }

    return decodeURIComponent(parts.join("/")).replace(/\.[a-z0-9]+$/i, "")
}

// Every Cloudinary photo StoreHatch refers to anywhere.
async function photosInUse(): Promise<Set<string>> {
    const [listings, images, shops, productReviews, shopReviews, messages] = await Promise.all([
        prisma.listing.findMany({ select: { imageUrl: true } }),
        prisma.listingImage.findMany({ select: { url: true } }),
        prisma.sellerProfile.findMany({ select: { logoUrl: true, bannerUrl: true } }),
        prisma.productReview.findMany({ where: { photoUrls: { isEmpty: false } }, select: { photoUrls: true } }),
        prisma.shopReview.findMany({ where: { photoUrls: { isEmpty: false } }, select: { photoUrls: true } }),
        prisma.disputeMessage.findMany({ select: { evidenceUrls: true } })
    ])
    const urls = [
        ...listings.map((listing) => listing.imageUrl),
        ...images.map((image) => image.url),
        ...shops.flatMap((shop) => [shop.logoUrl, shop.bannerUrl ?? ""]),
        ...productReviews.flatMap((review) => review.photoUrls),
        ...shopReviews.flatMap((review) => review.photoUrls),
        ...messages.flatMap((message) => Array.isArray(message.evidenceUrls) ? message.evidenceUrls.filter((url): url is string => typeof url === "string") : [])
    ]

    return new Set(urls.map(cloudinaryPublicId).filter((id): id is string => id !== null))
}

const maximumPagesPerRun = 20

// Deletes unused photos, at most once a day. Returns how many were deleted (null when it did not run).
export async function cleanUpUnusedPhotos(now = new Date()): Promise<number | null> {
    const settings = cloudinarySettings()
    const admin = adminForTesting ?? (settings ? cloudinaryAdmin(settings) : null)

    if (!admin || now.getTime() - lastPhotoCleanupAt < dayMs) {
        return null
    }

    lastPhotoCleanupAt = now.getTime()
    const inUse = await photosInUse()
    const cutoff = now.getTime() - unusedPhotoDays * dayMs
    const unused: string[] = []
    let cursor: string | null = null

    for (let page = 0; page < maximumPagesPerRun; page++) {
        const { photos, nextCursor } = await admin.listPhotos(cursor)
        unused.push(...photos.filter((photo) => photo.createdAt.getTime() < cutoff && !inUse.has(photo.publicId)).map((photo) => photo.publicId))
        cursor = nextCursor

        if (!cursor) {
            break
        }
    }

    for (let index = 0; index < unused.length; index += 100) {
        await admin.deletePhotos(unused.slice(index, index + 100))
    }

    return unused.length
}

export async function runHousekeeping(now = new Date()): Promise<void> {
    await purgeAbandonedCheckouts(now)
    await purgeOldPaymentEvents(now)
    await cleanUpUnusedPhotos(now)
}
