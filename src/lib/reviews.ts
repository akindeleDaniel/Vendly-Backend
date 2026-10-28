import { Prisma } from "../generated/prisma/client.js"
import prisma from "./prisma.js"
import { deletedUserName } from "./accountDeletion.js"

// Star reviews of products and shops. Only a buyer whose order was delivered can review it, once per product and
// once per shop, so reviews cannot be written by sellers or strangers. There is no seller reply. A buyer can
// change or remove their review for a week; an administrator can hide one that breaks the rules (a seller can
// report it), and a hidden review does not count in the rating.
export const maximumReviewCommentLength = 1000
export const reviewEditWindowDays = 7
export const reviewsPageSize = 10
export const maximumReportReasonLength = 300
// A review can carry a few photos of what arrived, which is what shoppers check most before trusting a seller.
export const maximumReviewPhotos = 3
const dayMs = 24 * 60 * 60 * 1000

export type ReviewKind = "product" | "shop"

export class ReviewRequestError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
        readonly code?: "REVIEW_NOT_ALLOWED" | "REVIEW_EXISTS" | "REVIEW_LOCKED",
        readonly details: Record<string, unknown> = {}
    ) {
        super(message)
    }
}

// ---- reading a request ----

export function parseRating(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null
}

// Undefined when no comment was given, null for a comment that is not text or is too long, "" never (blank becomes undefined).
export function parseComment(value: unknown): string | undefined | null {
    if (value === undefined || value === null) {
        return undefined
    }

    if (typeof value !== "string") {
        return null
    }

    // Plain text only: control characters are dropped, and runs of blank lines are collapsed.
    const comment = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\n{3,}/g, "\n\n").trim()
    return comment.length === 0 ? undefined : comment.length <= maximumReviewCommentLength ? comment : null
}

// Undefined when no photos were given; null when they are not a list of up to 3 https links. Repeats are dropped.
export function parsePhotoUrls(value: unknown): string[] | undefined | null {
    if (value === undefined) {
        return undefined
    }

    if (!Array.isArray(value) || value.length > maximumReviewPhotos) {
        return null
    }

    for (const entry of value) {
        if (typeof entry !== "string" || entry.length > 500) {
            return null
        }

        try {
            if (new URL(entry).protocol !== "https:") {
                return null
            }
        } catch {
            return null
        }
    }

    return [...new Set(value as string[])]
}

export function parseReportReason(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }

    const reason = value.trim()
    return reason.length >= 3 && reason.length <= maximumReportReasonLength ? reason : null
}

// ---- ratings ----

// The average to one decimal, or null when nothing has been rated.
export function averageRating(sum: number, count: number): number | null {
    return count === 0 ? null : Math.round((sum / count) * 10) / 10
}

// How the person who wrote a review is shown: first name and the first letter of the last name.
export function reviewerLabel(name: string): string {
    if (name === deletedUserName) {
        return "A former buyer"
    }

    const parts = name.trim().split(/\s+/).filter(Boolean)
    const first = parts[0] ?? "A buyer"
    const last = parts.length > 1 ? parts[parts.length - 1] : undefined
    return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first
}

// Recounts the visible reviews of one product or shop and stores the totals on it. Done from the reviews themselves
// each time, so the stored numbers cannot drift from them.
export async function recalculateRating(tx: Prisma.TransactionClient, kind: ReviewKind, subjectId: number): Promise<void> {
    if (kind === "product") {
        const totals = await tx.productReview.aggregate({ where: { listingId: subjectId, hiddenAt: null }, _count: { _all: true }, _sum: { rating: true } })
        await tx.listing.update({ where: { id: subjectId }, data: { ratingCount: totals._count._all, ratingSum: totals._sum.rating ?? 0 } })
    } else {
        const totals = await tx.shopReview.aggregate({ where: { sellerProfileId: subjectId, hiddenAt: null }, _count: { _all: true }, _sum: { rating: true } })
        await tx.sellerProfile.update({ where: { id: subjectId }, data: { ratingCount: totals._count._all, ratingSum: totals._sum.rating ?? 0 } })
    }
}

// ---- the buyer ----

export type NewReviewInput = {
    checkoutId: number
    orderId: number
    buyerId: number
    shop?: { rating: number; comment?: string; photoUrls?: string[] }
    products: Array<{ listingId: number; rating: number; comment?: string; photoUrls?: string[] }>
}

// A product's reviews belong to the product, not to the option that was bought: a review of "Hoodie, Blue / M" is a review
// of the hoodie.
type BoughtItem = { listingId: number; listing: { parentId: number | null } }

function reviewSubject(item: BoughtItem): number {
    return item.listing.parentId ?? item.listingId
}

// Loads one of the buyer's orders, or throws 404.
async function loadBuyerOrder(checkoutId: number, orderId: number, buyerId: number) {
    const order = await prisma.order.findFirst({
        where: { id: orderId, checkoutId, checkout: { userId: buyerId } },
        select: {
            id: true,
            status: true,
            sellerId: true,
            orderItems: { select: { listingId: true, title: true, listing: { select: { parentId: true, parent: { select: { title: true } } } } } },
            seller: { select: { sellerProfile: { select: { id: true } } } }
        }
    })

    if (!order) {
        throw new ReviewRequestError(404, "Order not found")
    }

    return order
}

export async function createOrderReviews(input: NewReviewInput) {
    const order = await loadBuyerOrder(input.checkoutId, input.orderId, input.buyerId)

    // Checkout already refuses a seller's own products; this keeps reviews safe even so.
    if (order.sellerId === input.buyerId) {
        throw new ReviewRequestError(409, "You cannot review your own shop or products", "REVIEW_NOT_ALLOWED")
    }

    if (order.status !== "DELIVERED") {
        throw new ReviewRequestError(409, "You can review an order once it has been delivered", "REVIEW_NOT_ALLOWED")
    }

    // Either the id of the option that was bought or the id of its product can be given.
    const subjectOf = new Map<number, number>()

    for (const item of order.orderItems) {
        subjectOf.set(item.listingId, reviewSubject(item))
        subjectOf.set(reviewSubject(item), reviewSubject(item))
    }

    if (input.products.some((product) => !subjectOf.has(product.listingId))) {
        throw new ReviewRequestError(400, "You can only review products from this order")
    }

    const sellerProfileId = order.seller.sellerProfile?.id

    if (input.shop && sellerProfileId === undefined) {
        throw new ReviewRequestError(400, "This seller has no shop to review")
    }

    try {
        return await prisma.$transaction(async (tx) => {
            const products = []

            for (const product of input.products) {
                const subject = subjectOf.get(product.listingId)!
                products.push(await tx.productReview.create({
                    data: { listingId: subject, buyerId: input.buyerId, orderId: order.id, rating: product.rating, comment: product.comment ?? null, photoUrls: product.photoUrls ?? [] }
                }))
                await recalculateRating(tx, "product", subject)
            }

            let shop = null

            if (input.shop && sellerProfileId !== undefined) {
                shop = await tx.shopReview.create({
                    data: { sellerProfileId, buyerId: input.buyerId, orderId: order.id, rating: input.shop.rating, comment: input.shop.comment ?? null, photoUrls: input.shop.photoUrls ?? [] }
                })
                await recalculateRating(tx, "shop", sellerProfileId)
            }

            return { products, shop }
        })
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            throw new ReviewRequestError(409, "You have already reviewed one of these", "REVIEW_EXISTS")
        }

        throw error
    }
}

// What the buyer can do about reviewing one of their orders, for the order page.
export async function getOrderReviewState(checkoutId: number, orderId: number, buyerId: number) {
    const order = await loadBuyerOrder(checkoutId, orderId, buyerId)
    const [productReviews, shopReview] = await Promise.all([
        prisma.productReview.findMany({ where: { buyerId, listingId: { in: order.orderItems.map(reviewSubject) } } }),
        order.seller.sellerProfile
            ? prisma.shopReview.findUnique({ where: { buyerId_sellerProfileId: { buyerId, sellerProfileId: order.seller.sellerProfile.id } } })
            : Promise.resolve(null)
    ])
    const now = Date.now()
    const shown = (review: { id: number; rating: number; comment: string | null; photoUrls: string[]; createdAt: Date; hiddenAt: Date | null }) => ({
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        photoUrls: review.photoUrls,
        createdAt: review.createdAt,
        hidden: review.hiddenAt !== null,
        canChange: now - review.createdAt.getTime() <= reviewEditWindowDays * dayMs
    })

    return {
        canReview: order.status === "DELIVERED",
        shop: shopReview ? shown(shopReview) : null,
        // One entry per product, even when several of its options were bought.
        products: order.orderItems
            .filter((item, index, items) => items.findIndex((other) => reviewSubject(other) === reviewSubject(item)) === index)
            .map((item) => {
                const review = productReviews.find((candidate) => candidate.listingId === reviewSubject(item))
                return { listingId: reviewSubject(item), title: item.listing.parent?.title ?? item.title, review: review ? shown(review) : null }
            })
    }
}

// Changes or removes the buyer's own review while the edit window is open. Returns what is left (null when removed).
export async function changeReview(
    kind: ReviewKind,
    reviewId: number,
    buyerId: number,
    change: { remove: true } | { remove?: false; rating?: number; comment?: string | null; photoUrls?: string[] }
) {
    const where = { id: reviewId, buyerId }
    const review = kind === "product"
        ? await prisma.productReview.findFirst({ where })
        : await prisma.shopReview.findFirst({ where })

    if (!review) {
        throw new ReviewRequestError(404, "Review not found")
    }

    if (Date.now() - review.createdAt.getTime() > reviewEditWindowDays * dayMs) {
        throw new ReviewRequestError(409, `A review can be changed or removed for ${reviewEditWindowDays} days after it is written`, "REVIEW_LOCKED")
    }

    const subjectId = "listingId" in review ? review.listingId : review.sellerProfileId

    return prisma.$transaction(async (tx) => {
        let updated = null

        if (change.remove) {
            if (kind === "product") {
                await tx.productReview.delete({ where: { id: reviewId } })
            } else {
                await tx.shopReview.delete({ where: { id: reviewId } })
            }
        } else {
            const data = {
                ...(change.rating !== undefined ? { rating: change.rating } : {}),
                ...(change.comment !== undefined ? { comment: change.comment } : {}),
                ...(change.photoUrls !== undefined ? { photoUrls: change.photoUrls } : {})
            }
            updated = kind === "product"
                ? await tx.productReview.update({ where: { id: reviewId }, data })
                : await tx.shopReview.update({ where: { id: reviewId }, data })
        }

        await recalculateRating(tx, kind, subjectId)
        return updated
    })
}

// ---- reading reviews (public) ----

type ReviewRow = { id: number; rating: number; comment: string | null; photoUrls: string[]; createdAt: Date; updatedAt: Date; buyer: { name: string } }

function toPublicReview(review: ReviewRow) {
    return {
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        photoUrls: review.photoUrls,
        reviewer: reviewerLabel(review.buyer.name),
        createdAt: review.createdAt,
        // True when the buyer changed it after writing it.
        edited: review.updatedAt.getTime() - review.createdAt.getTime() > 1000
    }
}

export type ReviewSummary = { average: number | null; count: number; distribution: Record<string, number>; withPhotos: number }

// The average, the count, how many of each star and how many have photos, for the visible reviews matching where
// (hidden reviews never count, so this matches the stored rating shoppers see).
export async function reviewSummary(kind: ReviewKind, where: Prisma.ProductReviewWhereInput | Prisma.ShopReviewWhereInput): Promise<ReviewSummary> {
    const visible = { ...where, hiddenAt: null }
    const withPhotos = { ...visible, photoUrls: { isEmpty: false } }
    const [groups, photoCount] = kind === "product"
        ? await Promise.all([
            prisma.productReview.groupBy({ by: ["rating"], where: visible as Prisma.ProductReviewWhereInput, _count: { _all: true } }),
            prisma.productReview.count({ where: withPhotos as Prisma.ProductReviewWhereInput })
        ])
        : await Promise.all([
            prisma.shopReview.groupBy({ by: ["rating"], where: visible as Prisma.ShopReviewWhereInput, _count: { _all: true } }),
            prisma.shopReview.count({ where: withPhotos as Prisma.ShopReviewWhereInput })
        ])
    const distribution: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 }
    let count = 0
    let sum = 0

    for (const group of groups) {
        distribution[String(group.rating)] = group._count._all
        count += group._count._all
        sum += group.rating * group._count._all
    }

    return { average: averageRating(sum, count), count, distribution, withPhotos: photoCount }
}

// A product's or shop's visible reviews, newest first, with the average, the count, how many of each star and how
// many have photos. With photosOnly, only the reviews with photos are listed (the summary still covers them all).
export async function listPublicReviews(kind: ReviewKind, subjectId: number, page: number, photosOnly = false) {
    const subject = kind === "product" ? { listingId: subjectId } : { sellerProfileId: subjectId }
    const visible = { ...subject, hiddenAt: null }
    const listed = photosOnly ? { ...visible, photoUrls: { isEmpty: false } } : visible
    const select = { id: true, rating: true, comment: true, photoUrls: true, createdAt: true, updatedAt: true, buyer: { select: { name: true } } }
    const paging = { orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }], skip: (page - 1) * reviewsPageSize, take: reviewsPageSize, select }
    const [reviews, summary] = kind === "product"
        ? await Promise.all([prisma.productReview.findMany({ where: listed as Prisma.ProductReviewWhereInput, ...paging }), reviewSummary(kind, subject)])
        : await Promise.all([prisma.shopReview.findMany({ where: listed as Prisma.ShopReviewWhereInput, ...paging }), reviewSummary(kind, subject)])

    return {
        page,
        pageSize: reviewsPageSize,
        summary,
        reviews: reviews.map(toPublicReview)
    }
}
