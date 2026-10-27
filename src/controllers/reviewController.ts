import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import {
    changeReview,
    createOrderReviews,
    getOrderReviewState,
    listPublicReviews,
    maximumReviewCommentLength,
    maximumReviewPhotos,
    parseComment,
    parsePhotoUrls,
    parseRating,
    parseReportReason,
    recalculateRating,
    ReviewRequestError,
    reviewsPageSize,
    type ReviewKind
} from "../lib/reviews.js"
import { notifyNewReviews, queueNotification } from "../lib/notifications.js"

const maximumProductsPerRequest = 20
const adminPageSize = 20

function parseId(value: unknown): number | null {
    const id = Number(value)
    return Number.isSafeInteger(id) && id > 0 ? id : null
}

function parsePage(value: unknown): number | null {
    if (value === undefined) {
        return 1
    }

    const page = Number(value)
    return typeof value === "string" && Number.isSafeInteger(page) && page >= 1 ? page : null
}

function parseKind(value: unknown): ReviewKind | null {
    return value === "products" ? "product" : value === "shops" ? "shop" : null
}

function sendReviewError(error: unknown, res: Response): boolean {
    if (error instanceof ReviewRequestError) {
        res.status(error.statusCode).send({ message: error.message, ...(error.code ? { code: error.code } : {}), ...error.details })
        return true
    }

    return false
}

const commentProblem = `Comments can be up to ${maximumReviewCommentLength} characters`
const ratingProblem = "Rating must be a whole number from 1 to 5"
const photosProblem = `Photos must be up to ${maximumReviewPhotos} https links`

function toBuyerReview(review: { id: number; rating: number; comment: string | null; photoUrls: string[]; createdAt: Date; hiddenAt: Date | null }) {
    return { id: review.id, rating: review.rating, comment: review.comment, photoUrls: review.photoUrls, createdAt: review.createdAt, hidden: review.hiddenAt !== null }
}

// ---------------------------------------------------------------------------
// The buyer
// ---------------------------------------------------------------------------

// Whether this order can be reviewed yet, and what the buyer has already written about it.
export const getMyOrderReviews = async (req: Request, res: Response) => {
    const checkoutId = parseId(req.params.id)
    const orderId = parseId(req.params.orderId)

    try {
        if (checkoutId === null || orderId === null) {
            throw new ReviewRequestError(404, "Order not found")
        }

        res.send(await getOrderReviewState(checkoutId, orderId, req.user!.id))
    } catch (error) {
        if (!sendReviewError(error, res)) {
            throw error
        }
    }
}

// Reviews the shop, the products, or both, for a delivered order. Nothing is saved unless every part is valid.
export const createMyOrderReviews = async (req: Request, res: Response) => {
    const checkoutId = parseId(req.params.id)
    const orderId = parseId(req.params.orderId)
    const { shop, products } = req.body as { shop?: unknown; products?: unknown }

    if (checkoutId === null || orderId === null) {
        res.status(404).send({ message: "Order not found" })
        return
    }

    if (shop === undefined && products === undefined) {
        res.status(400).send({ message: "Review the shop, a product, or both" })
        return
    }

    let shopReview: { rating: number; comment?: string; photoUrls?: string[] } | undefined

    if (shop !== undefined) {
        const input = shop as { rating?: unknown; comment?: unknown; photoUrls?: unknown } | null
        const rating = typeof input === "object" && input !== null ? parseRating(input.rating) : null
        const comment = typeof input === "object" && input !== null ? parseComment(input.comment) : null
        const photoUrls = typeof input === "object" && input !== null ? parsePhotoUrls(input.photoUrls) : undefined

        if (rating === null) {
            res.status(400).send({ message: ratingProblem })
            return
        }

        if (comment === null) {
            res.status(400).send({ message: commentProblem })
            return
        }

        if (photoUrls === null) {
            res.status(400).send({ message: photosProblem })
            return
        }

        shopReview = { rating, ...(comment !== undefined ? { comment } : {}), ...(photoUrls !== undefined ? { photoUrls } : {}) }
    }

    const productReviews: Array<{ listingId: number; rating: number; comment?: string; photoUrls?: string[] }> = []

    if (products !== undefined) {
        if (!Array.isArray(products) || products.length === 0 || products.length > maximumProductsPerRequest) {
            res.status(400).send({ message: `Products must be a list of 1 to ${maximumProductsPerRequest} reviews` })
            return
        }

        for (const entry of products as Array<{ listingId?: unknown; rating?: unknown; comment?: unknown; photoUrls?: unknown } | null>) {
            const listingId = typeof entry === "object" && entry !== null ? parseId(entry.listingId) : null
            const rating = typeof entry === "object" && entry !== null ? parseRating(entry.rating) : null
            const comment = typeof entry === "object" && entry !== null ? parseComment(entry.comment) : null
            const photoUrls = typeof entry === "object" && entry !== null ? parsePhotoUrls(entry.photoUrls) : undefined

            if (listingId === null || rating === null) {
                res.status(400).send({ message: listingId === null ? "Each product review needs a listingId" : ratingProblem })
                return
            }

            if (comment === null) {
                res.status(400).send({ message: commentProblem })
                return
            }

            if (photoUrls === null) {
                res.status(400).send({ message: photosProblem })
                return
            }

            productReviews.push({ listingId, rating, ...(comment !== undefined ? { comment } : {}), ...(photoUrls !== undefined ? { photoUrls } : {}) })
        }

        if (new Set(productReviews.map((review) => review.listingId)).size !== productReviews.length) {
            res.status(400).send({ message: "Each product can only be reviewed once in a request" })
            return
        }
    }

    try {
        const created = await createOrderReviews({
            checkoutId,
            orderId,
            buyerId: req.user!.id,
            ...(shopReview ? { shop: shopReview } : {}),
            products: productReviews
        })

        queueNotification("new review", () => notifyNewReviews(created.products.map((review) => review.id), created.shop?.id ?? null))
        res.status(201).send({
            shop: created.shop ? toBuyerReview(created.shop) : null,
            products: created.products.map((review) => ({ listingId: review.listingId, ...toBuyerReview(review) }))
        })
    } catch (error) {
        if (!sendReviewError(error, res)) {
            throw error
        }
    }
}

export const changeMyReview = async (req: Request, res: Response) => {
    const kind = parseKind(req.params.kind)
    const reviewId = parseId(req.params.reviewId)
    const rating = req.body.rating === undefined ? undefined : parseRating(req.body.rating)
    const comment = req.body.comment === undefined ? undefined : req.body.comment === null ? null : parseComment(req.body.comment)
    // The whole set of photos: an empty list removes them all.
    const photoUrls = parsePhotoUrls(req.body.photoUrls)

    if (!kind || reviewId === null) {
        res.status(404).send({ message: "Review not found" })
        return
    }

    if (rating === null) {
        res.status(400).send({ message: ratingProblem })
        return
    }

    if (comment === null && req.body.comment !== null) {
        res.status(400).send({ message: commentProblem })
        return
    }

    if (photoUrls === null) {
        res.status(400).send({ message: photosProblem })
        return
    }

    if (rating === undefined && comment === undefined && photoUrls === undefined) {
        res.status(400).send({ message: "Provide a rating, a comment or photos to change" })
        return
    }

    try {
        const updated = await changeReview(kind, reviewId, req.user!.id, {
            ...(rating !== undefined ? { rating } : {}),
            ...(photoUrls !== undefined ? { photoUrls } : {}),
            // A blank comment clears it; undefined from the parser (blank text) means "no comment".
            ...(comment !== undefined || req.body.comment !== undefined ? { comment: comment ?? null } : {})
        })
        res.send({ review: updated ? toBuyerReview(updated) : null })
    } catch (error) {
        if (!sendReviewError(error, res)) {
            throw error
        }
    }
}

export const removeMyReview = async (req: Request, res: Response) => {
    const kind = parseKind(req.params.kind)
    const reviewId = parseId(req.params.reviewId)

    if (!kind || reviewId === null) {
        res.status(404).send({ message: "Review not found" })
        return
    }

    try {
        await changeReview(kind, reviewId, req.user!.id, { remove: true })
        res.send({ message: "Review removed" })
    } catch (error) {
        if (!sendReviewError(error, res)) {
            throw error
        }
    }
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export const listListingReviews = async (req: Request, res: Response) => {
    const listingId = parseId(req.params.id)
    const page = parsePage(req.query.page)

    if (page === null) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    const listing = listingId === null ? null : await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, archivedAt: true, parentId: true } })

    if (!listing || listing.archivedAt) {
        res.status(404).send({ message: "Listing not found" })
        return
    }

    // A choice of a product shows the product's reviews.
    res.send(await listPublicReviews("product", listing.parentId ?? listing.id, page, req.query.withPhotos === "true"))
}

export const listShopReviews = async (req: Request, res: Response) => {
    const slug = req.params.slug
    const page = parsePage(req.query.page)

    if (page === null) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    const profile = typeof slug === "string" ? await prisma.sellerProfile.findUnique({ where: { slug }, select: { id: true } }) : null

    if (!profile) {
        res.status(404).send({ message: "Store not found" })
        return
    }

    res.send(await listPublicReviews("shop", profile.id, page, req.query.withPhotos === "true"))
}

// ---------------------------------------------------------------------------
// The seller
// ---------------------------------------------------------------------------

// The reviews of the seller's own shop and products, including reported and hidden ones.
export const listMyReviews = async (req: Request, res: Response) => {
    const page = parsePage(req.query.page)
    const type = req.query.type === undefined ? "shop" : req.query.type === "shop" || req.query.type === "product" ? req.query.type : null

    if (page === null || type === null) {
        res.status(400).send({ message: page === null ? "Page must be a positive whole number" : "Type must be shop or product" })
        return
    }

    const paging = { orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }], skip: (page - 1) * reviewsPageSize, take: reviewsPageSize }
    const select = { id: true, rating: true, comment: true, photoUrls: true, createdAt: true, reportedAt: true, hiddenAt: true, buyer: { select: { name: true } } }

    if (type === "shop") {
        const profile = await prisma.sellerProfile.findUnique({ where: { userId: req.user!.id }, select: { id: true, ratingCount: true, ratingSum: true } })

        if (!profile) {
            res.status(404).send({ message: "Store profile not found" })
            return
        }

        const where = { sellerProfileId: profile.id }
        const [total, rows] = await Promise.all([prisma.shopReview.count({ where }), prisma.shopReview.findMany({ where, select, ...paging })])
        res.send({ page, pageSize: reviewsPageSize, total, reviews: rows.map(toSellerReview) })
        return
    }

    const where = { listing: { userId: req.user!.id } }
    const [total, rows] = await Promise.all([
        prisma.productReview.count({ where }),
        prisma.productReview.findMany({ where, select: { ...select, listing: { select: { id: true, title: true } } }, ...paging })
    ])
    res.send({
        page,
        pageSize: reviewsPageSize,
        total,
        reviews: rows.map((row) => ({ ...toSellerReview(row), listing: row.listing }))
    })
}

function toSellerReview(row: { id: number; rating: number; comment: string | null; photoUrls: string[]; createdAt: Date; reportedAt: Date | null; hiddenAt: Date | null; buyer: { name: string } }) {
    return {
        id: row.id,
        rating: row.rating,
        comment: row.comment,
        photoUrls: row.photoUrls,
        reviewer: row.buyer.name.trim().split(/\s+/)[0] ?? "A buyer",
        createdAt: row.createdAt,
        reported: row.reportedAt !== null,
        hidden: row.hiddenAt !== null
    }
}

// Reports a review of the seller's own shop or product for an administrator to look at. Reporting twice changes nothing.
export const reportReview = async (req: Request, res: Response) => {
    const kind = parseKind(req.params.kind)
    const reviewId = parseId(req.params.reviewId)
    const reason = parseReportReason(req.body.reason)

    if (!kind || reviewId === null) {
        res.status(404).send({ message: "Review not found" })
        return
    }

    if (reason === null) {
        res.status(400).send({ message: "Say why in 3 to 300 characters" })
        return
    }

    const now = new Date()
    const result = kind === "product"
        ? await prisma.productReview.updateMany({ where: { id: reviewId, listing: { userId: req.user!.id }, reportedAt: null }, data: { reportedAt: now, reportReason: reason } })
        : await prisma.shopReview.updateMany({ where: { id: reviewId, sellerProfile: { userId: req.user!.id }, reportedAt: null }, data: { reportedAt: now, reportReason: reason } })

    if (result.count === 0) {
        const owned = kind === "product"
            ? await prisma.productReview.findFirst({ where: { id: reviewId, listing: { userId: req.user!.id } }, select: { id: true } })
            : await prisma.shopReview.findFirst({ where: { id: reviewId, sellerProfile: { userId: req.user!.id } }, select: { id: true } })

        if (!owned) {
            res.status(404).send({ message: "Review not found" })
            return
        }
    }

    res.send({ message: "Thank you. StoreHatch will look at this review." })
}

// ---------------------------------------------------------------------------
// Administrators
// ---------------------------------------------------------------------------

const adminStatuses = ["reported", "hidden", "visible", "all"] as const

// Reviews for an administrator to look at: reported ones by default.
export const listAdminReviews = async (req: Request, res: Response) => {
    const page = parsePage(req.query.page)
    const type = req.query.type === undefined ? "product" : req.query.type === "shop" || req.query.type === "product" ? req.query.type : null
    const status = req.query.status === undefined ? "reported" : adminStatuses.find((candidate) => candidate === req.query.status) ?? null

    if (page === null || type === null || status === null) {
        res.status(400).send({ message: page === null ? "Page must be a positive whole number" : type === null ? "Type must be shop or product" : `Status must be one of ${adminStatuses.join(", ")}` })
        return
    }

    const filter = status === "reported" ? { reportedAt: { not: null }, hiddenAt: null } : status === "hidden" ? { hiddenAt: { not: null } } : status === "visible" ? { hiddenAt: null } : {}
    const paging = { orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }], skip: (page - 1) * adminPageSize, take: adminPageSize }
    const select = {
        id: true,
        rating: true,
        comment: true,
        photoUrls: true,
        createdAt: true,
        reportedAt: true,
        reportReason: true,
        hiddenAt: true,
        hiddenReason: true,
        orderId: true,
        buyer: { select: { id: true, name: true, email: true } }
    }

    if (type === "shop") {
        const [total, rows] = await Promise.all([
            prisma.shopReview.count({ where: filter }),
            prisma.shopReview.findMany({ where: filter, select: { ...select, sellerProfile: { select: { id: true, businessName: true, slug: true } } }, ...paging })
        ])
        res.send({ page, pageSize: adminPageSize, total, reviews: rows.map(({ sellerProfile, ...row }) => ({ ...row, type: "shop", subject: sellerProfile })) })
        return
    }

    const [total, rows] = await Promise.all([
        prisma.productReview.count({ where: filter }),
        prisma.productReview.findMany({ where: filter, select: { ...select, listing: { select: { id: true, title: true } } }, ...paging })
    ])
    res.send({ page, pageSize: adminPageSize, total, reviews: rows.map(({ listing, ...row }) => ({ ...row, type: "product", subject: listing })) })
}

// Hides or shows a review. A hidden review is not listed and does not count in the rating; the reason is kept.
export const setReviewHidden = (hide: boolean) => async (req: Request, res: Response) => {
    const kind = parseKind(req.params.kind)
    const reviewId = parseId(req.params.reviewId)
    const reason = hide ? parseReportReason(req.body.reason) : null

    if (!kind || reviewId === null) {
        res.status(404).send({ message: "Review not found" })
        return
    }

    if (hide && reason === null) {
        res.status(400).send({ message: "Say why in 3 to 300 characters" })
        return
    }

    const data = hide ? { hiddenAt: new Date(), hiddenReason: reason, hiddenById: req.user!.id } : { hiddenAt: null, hiddenReason: null, hiddenById: null }
    const found = await prisma.$transaction(async (tx) => {
        const review = kind === "product"
            ? await tx.productReview.findUnique({ where: { id: reviewId }, select: { listingId: true } })
            : await tx.shopReview.findUnique({ where: { id: reviewId }, select: { sellerProfileId: true } })

        if (!review) {
            return false
        }

        if (kind === "product") {
            await tx.productReview.update({ where: { id: reviewId }, data })
            await recalculateRating(tx, "product", (review as { listingId: number }).listingId)
        } else {
            await tx.shopReview.update({ where: { id: reviewId }, data })
            await recalculateRating(tx, "shop", (review as { sellerProfileId: number }).sellerProfileId)
        }

        return true
    })

    if (!found) {
        res.status(404).send({ message: "Review not found" })
        return
    }

    res.send({ message: hide ? "Review hidden" : "Review shown again" })
}
