import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { getCanonicalCategory } from "../lib/categories.js"
import { isHttpsUrl, maximumListingTitleLength, priceProblem } from "../lib/inputRules.js"
import { listingTextProblem, stockProblem } from "./listingController.js"

// Adding products from photos, the way sellers already sell on WhatsApp: photo first, details after. Each photo
// becomes a draft, a product that is off sale and hidden everywhere (like an archived one, so every rule that hides
// products hides drafts too). The seller fills in the details on the quick edit screen (PATCH /listings/bulk) and
// publishes; only complete drafts go on sale.
export const maximumDraftPhotos = 50
export const untitledProduct = "Untitled product"

type DraftProblem = { listingId: number; field: string; message: string }

// What a draft still needs before it can go on sale. Empty when it is ready.
export function draftProblems(listing: { id: number; title: string; description: string; price: number; stockQuantity: number; category: string; imageUrl: string }): DraftProblem[] {
    const problems: DraftProblem[] = []
    const problem = (field: string, message: string) => problems.push({ listingId: listing.id, field, message })

    if (listing.title.trim() === "" || listing.title === untitledProduct) {
        problem("title", "Give it a name")
    } else {
        const textProblem = listingTextProblem({ title: listing.title })
        textProblem && problem("title", textProblem)
    }

    if (listing.description.trim() === "") {
        problem("description", "Add a description")
    }

    if (listing.price <= 0) {
        problem("price", "Add a price")
    } else {
        const error = priceProblem(listing.price)
        error && problem("price", error)
    }

    const stockError = stockProblem(listing.stockQuantity)
    stockError && problem("stockQuantity", stockError)

    if (!getCanonicalCategory(listing.category)) {
        problem("category", "Choose a category")
    }

    if (!isHttpsUrl(listing.imageUrl)) {
        problem("imageUrl", "Add a photo")
    }

    return problems
}

// POST /listings/drafts { photos: [{ imageUrl, title? }] }: one draft per photo (uploaded first, as for any product).
// A title can come from the photo's file name; without one it is "Untitled product".
export const createDrafts = async (req: Request, res: Response) => {
    const photos = req.body.photos

    if (!Array.isArray(photos) || photos.length === 0 || photos.length > maximumDraftPhotos) {
        res.status(400).send({ message: `Send between 1 and ${maximumDraftPhotos} photos in photos` })
        return
    }

    const drafts: Array<{ imageUrl: string; title: string }> = []

    for (const [index, entry] of (photos as Array<{ imageUrl?: unknown; title?: unknown } | null>).entries()) {
        if (typeof entry !== "object" || entry === null || !isHttpsUrl(entry.imageUrl)) {
            res.status(400).send({ message: `Photo ${index + 1} needs an https imageUrl` })
            return
        }

        const title = typeof entry.title === "string" ? entry.title.replace(/\s+/g, " ").trim().slice(0, maximumListingTitleLength) : ""
        drafts.push({ imageUrl: entry.imageUrl, title: title || untitledProduct })
    }

    const profile = await prisma.sellerProfile.findUnique({ where: { userId: req.user!.id }, select: { id: true } })

    if (!profile) {
        res.status(400).send({ message: "Set up your store before creating a listing" })
        return
    }

    const now = new Date()
    const created = await prisma.$transaction(drafts.map((draft) => prisma.listing.create({
        data: {
            userId: req.user!.id,
            title: draft.title,
            description: "",
            price: 0,
            stockQuantity: 0,
            category: "",
            imageUrl: draft.imageUrl,
            archivedAt: now,
            isDraft: true,
            images: { create: [{ url: draft.imageUrl, position: 0 }] }
        },
        select: { id: true, title: true, imageUrl: true }
    })))

    res.status(201).send({ count: created.length, drafts: created.map((draft) => ({ listingId: draft.id, title: draft.title, imageUrl: draft.imageUrl })) })
}

// POST /listings/drafts/publish { listingIds }: puts the complete drafts on sale. Drafts are separate products, so
// the complete ones are published even when others still need work; those are listed with what is missing.
export const publishDrafts = async (req: Request, res: Response) => {
    const ids = req.body.listingIds

    if (!Array.isArray(ids) || ids.length === 0 || ids.length > maximumDraftPhotos || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
        res.status(400).send({ message: `Send between 1 and ${maximumDraftPhotos} draft ids in listingIds` })
        return
    }

    const drafts = await prisma.listing.findMany({ where: { id: { in: ids as number[] }, userId: req.user!.id, isDraft: true } })
    const found = new Set(drafts.map((draft) => draft.id))
    const problems: DraftProblem[] = (ids as number[]).filter((id) => !found.has(id)).map((id) => ({ listingId: id, field: "listingId", message: "Draft not found" }))
    const ready: number[] = []

    for (const draft of drafts) {
        const missing = draftProblems(draft)
        missing.length === 0 ? ready.push(draft.id) : problems.push(...missing)
    }

    if (ready.length > 0) {
        await prisma.$transaction(async (tx) => {
            for (const draft of drafts.filter((candidate) => ready.includes(candidate.id))) {
                // Its options were hidden with it and go on sale with it.
                if (draft.archivedAt) {
                    await tx.listing.updateMany({ where: { parentId: draft.id, archivedAt: draft.archivedAt }, data: { archivedAt: null } })
                }

                await tx.listing.updateMany({ where: { id: draft.id, isDraft: true }, data: { isDraft: false, archivedAt: null } })
            }
        })
    }

    res.send({ published: ready, problems })
}
