import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import type { DisputeStatus, Prisma } from "../generated/prisma/client.js"
import {
    addDisputeMessage,
    appealDispute,
    buyerDisputeReasons,
    DisputeRequestError,
    maximumEvidenceLinks,
    maximumMessageLength,
    minimumMessageLength,
    openDispute,
    parseEvidenceUrls,
    parseMessageBody,
    parseNairaToKobo,
    respondToDispute,
    withdrawDispute
} from "../lib/disputes.js"
import { countUnreadDisputes, markDisputeRead, unreadDisputeIds, type ReadingParty } from "../lib/disputeUnread.js"
import { disputeDetailInclude, disputeListInclude, toDisputeDetail, toDisputeSummary } from "../lib/disputeViews.js"
import type { DisputeViewer } from "../lib/disputeViews.js"

const pageSize = 20
const disputeStatuses: DisputeStatus[] = ["OPEN", "SELLER_AGREED", "UNDER_REVIEW", "RESOLVED", "WITHDRAWN"]

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

function sendDisputeError(error: unknown, res: Response): boolean {
    if (error instanceof DisputeRequestError) {
        res.status(error.statusCode).send({
            message: error.message,
            ...(error.code ? { code: error.code } : {}),
            ...error.details
        })
        return true
    }

    return false
}

// A message and any evidence links from a request body, or the problem to report.
function readThreadInput(body: Record<string, unknown>): { message: string; evidenceUrls: string[] } | { error: string } {
    const message = parseMessageBody(body.message)
    const evidenceUrls = parseEvidenceUrls(body.evidenceUrls)

    if (message === null) {
        return { error: `A message of ${minimumMessageLength} to ${maximumMessageLength} characters is required` }
    }

    if (evidenceUrls === null) {
        return { error: `Evidence must be up to ${maximumEvidenceLinks} https links` }
    }

    return { message, evidenceUrls }
}

export async function loadDisputeDetail(id: number, viewer: DisputeViewer) {
    const dispute = await prisma.dispute.findUnique({ where: { id }, include: disputeDetailInclude })
    return dispute ? toDisputeDetail(dispute, viewer) : null
}

// Lists complaints matching `where`, newest first. With no ?status=, only defaultStatuses are listed when given.
export async function listDisputes(req: Request, res: Response, where: Prisma.DisputeWhereInput, defaultStatuses?: DisputeStatus[], reader?: ReadingParty) {
    const page = parsePage(req.query.page)
    const status = req.query.status === undefined ? undefined : disputeStatuses.find((candidate) => candidate === req.query.status) ?? null

    if (page === null) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    if (status === null) {
        res.status(400).send({ message: `Status must be one of ${disputeStatuses.join(", ")}` })
        return
    }

    const filter: Prisma.DisputeWhereInput = {
        ...where,
        ...(status ? { status } : defaultStatuses ? { status: { in: defaultStatuses } } : {})
    }
    const [total, disputes] = await Promise.all([
        prisma.dispute.count({ where: filter }),
        prisma.dispute.findMany({
            where: filter,
            include: disputeListInclude,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (page - 1) * pageSize,
            take: pageSize
        })
    ])

    // Buyers and sellers are told which complaints have messages they have not opened yet.
    const unread = reader ? await unreadDisputeIds(reader, req.user!.id, disputes.map((dispute) => dispute.id)) : null

    res.send({
        page,
        pageSize,
        total,
        disputes: disputes.map((dispute) => unread ? { ...toDisputeSummary(dispute), unread: unread.has(dispute.id) } : toDisputeSummary(dispute))
    })
}

export async function showDispute(res: Response, id: number | null, where: Prisma.DisputeWhereInput, viewer: DisputeViewer) {
    // Taken before loading, so a message that arrives while this runs is still new next time.
    const seenAt = new Date()
    const dispute = id === null ? null : await prisma.dispute.findFirst({ where: { ...where, id }, include: disputeDetailInclude })

    if (!dispute) {
        res.status(404).send({ message: "Complaint not found" })
        return
    }

    if (viewer !== "ADMIN") {
        await markDisputeRead(viewer, dispute.id, seenAt)
    }

    res.send({ dispute: toDisputeDetail(dispute, viewer) })
}

// ---------------------------------------------------------------------------
// Buyers
// ---------------------------------------------------------------------------

// A buyer complains about one seller order, for example that it never arrived or was damaged, and
// says how much they are asking to be refunded (everything still refundable if they do not say).
export const openBuyerDispute = async (req: Request, res: Response) => {
    const checkoutId = parseId(req.params.id)
    const orderId = parseId(req.params.orderId)
    const reason = buyerDisputeReasons.find((candidate) => candidate === req.body.reason)
    const thread = readThreadInput(req.body)
    const requestedKobo = parseNairaToKobo(req.body.amount)

    if (checkoutId === null || orderId === null) {
        res.status(404).send({ message: "Order not found" })
        return
    }

    if (!reason) {
        res.status(400).send({ message: `Reason must be one of ${buyerDisputeReasons.join(", ")}` })
        return
    }

    if ("error" in thread) {
        res.status(400).send({ message: thread.error })
        return
    }

    if (requestedKobo === null) {
        res.status(400).send({ message: "Amount must be a positive number with at most two decimal places" })
        return
    }

    try {
        const id = await openDispute({
            actor: { party: "BUYER", userId: req.user!.id },
            orderId,
            checkoutId,
            reason,
            message: thread.message,
            evidenceUrls: thread.evidenceUrls,
            requestedKobo: requestedKobo ?? null
        })
        res.status(201).send({ dispute: await loadDisputeDetail(id, "BUYER") })
    } catch (error) {
        if (!sendDisputeError(error, res)) {
            throw error
        }
    }
}

export const listMyDisputes = (req: Request, res: Response) =>
    listDisputes(req, res, { order: { checkout: { userId: req.user!.id } } }, undefined, "BUYER")

// How many of the buyer's complaints have a reply they have not opened yet, for a notice on the site.
export const countBuyerUnreadDisputes = async (req: Request, res: Response) => {
    res.send({ count: await countUnreadDisputes("BUYER", req.user!.id) })
}

export const getMyDispute = (req: Request, res: Response) =>
    showDispute(res, parseId(req.params.id), { order: { checkout: { userId: req.user!.id } } }, "BUYER")

export const postBuyerMessage = async (req: Request, res: Response) => {
    const disputeId = parseId(req.params.id)
    const thread = readThreadInput(req.body)

    if ("error" in thread) {
        res.status(400).send({ message: thread.error })
        return
    }

    try {
        if (disputeId === null) {
            throw new DisputeRequestError(404, "Complaint not found")
        }

        await addDisputeMessage({ disputeId, actor: { party: "BUYER", userId: req.user!.id }, ...thread })
        await markDisputeRead("BUYER", disputeId, new Date())
        res.status(201).send({ dispute: await loadDisputeDetail(disputeId, "BUYER") })
    } catch (error) {
        if (!sendDisputeError(error, res)) {
            throw error
        }
    }
}

// The buyer appeals a rejection by Vendly, once, within 7 days, with a new message and any new evidence.
export const appealMyDispute = async (req: Request, res: Response) => {
    const disputeId = parseId(req.params.id)
    const thread = readThreadInput(req.body)

    if ("error" in thread) {
        res.status(400).send({ message: thread.error })
        return
    }

    try {
        if (disputeId === null) {
            throw new DisputeRequestError(404, "Complaint not found")
        }

        await appealDispute({ disputeId, buyerId: req.user!.id, ...thread })
        await markDisputeRead("BUYER", disputeId, new Date())
        res.status(201).send({ dispute: await loadDisputeDetail(disputeId, "BUYER") })
    } catch (error) {
        if (!sendDisputeError(error, res)) {
            throw error
        }
    }
}

export const withdrawMyDispute = async (req: Request, res: Response) => {
    const disputeId = parseId(req.params.id)

    try {
        if (disputeId === null) {
            throw new DisputeRequestError(404, "Complaint not found")
        }

        await withdrawDispute({ disputeId, actor: { party: "BUYER", userId: req.user!.id } })
        res.send({ dispute: await loadDisputeDetail(disputeId, "BUYER") })
    } catch (error) {
        if (!sendDisputeError(error, res)) {
            throw error
        }
    }
}

// ---------------------------------------------------------------------------
// Sellers
// ---------------------------------------------------------------------------

export const listSellerDisputes = (req: Request, res: Response) =>
    listDisputes(req, res, { order: { sellerId: req.user!.id } }, undefined, "SELLER")

// How many of the seller's complaints have messages they have not opened yet (different from the ones awaiting their answer).
export const countSellerUnreadDisputes = async (req: Request, res: Response) => {
    res.send({ count: await countUnreadDisputes("SELLER", req.user!.id) })
}

export const getSellerDispute = (req: Request, res: Response) =>
    showDispute(res, parseId(req.params.id), { order: { sellerId: req.user!.id } }, "SELLER")

// How many complaints are waiting for this seller's answer, for a notice on the site.
export const countSellerDisputesAwaitingResponse = async (req: Request, res: Response) => {
    const count = await prisma.dispute.count({ where: { status: "OPEN", order: { sellerId: req.user!.id } } })
    res.send({ count })
}

export const respondToMyDispute = async (req: Request, res: Response) => {
    const disputeId = parseId(req.params.id)
    const action = (["AGREE_TO_REFUND", "DISAGREE"] as const).find((candidate) => candidate === req.body.action)
    const thread = readThreadInput(req.body)

    if (!action) {
        res.status(400).send({ message: "Action must be AGREE_TO_REFUND or DISAGREE" })
        return
    }

    if ("error" in thread) {
        res.status(400).send({ message: thread.error })
        return
    }

    try {
        if (disputeId === null) {
            throw new DisputeRequestError(404, "Complaint not found")
        }

        await respondToDispute({ disputeId, sellerId: req.user!.id, action, ...thread })
        res.send({ dispute: await loadDisputeDetail(disputeId, "SELLER") })
    } catch (error) {
        if (!sendDisputeError(error, res)) {
            throw error
        }
    }
}

export const postSellerMessage = async (req: Request, res: Response) => {
    const disputeId = parseId(req.params.id)
    const thread = readThreadInput(req.body)

    if ("error" in thread) {
        res.status(400).send({ message: thread.error })
        return
    }

    try {
        if (disputeId === null) {
            throw new DisputeRequestError(404, "Complaint not found")
        }

        await addDisputeMessage({ disputeId, actor: { party: "SELLER", userId: req.user!.id }, ...thread })
        await markDisputeRead("SELLER", disputeId, new Date())
        res.status(201).send({ dispute: await loadDisputeDetail(disputeId, "SELLER") })
    } catch (error) {
        if (!sendDisputeError(error, res)) {
            throw error
        }
    }
}

// The seller offers to refund a paid order (all of it unless they give an amount). The buyer does
// not have to agree to money coming back; an administrator approves it.
export const offerRefund = async (req: Request, res: Response) => {
    const orderId = parseId(req.params.id)
    const thread = readThreadInput(req.body)
    const requestedKobo = parseNairaToKobo(req.body.amount)

    if (orderId === null) {
        res.status(404).send({ message: "Order not found" })
        return
    }

    if ("error" in thread) {
        res.status(400).send({ message: thread.error })
        return
    }

    if (requestedKobo === null) {
        res.status(400).send({ message: "Amount must be a positive number with at most two decimal places" })
        return
    }

    try {
        const id = await openDispute({
            actor: { party: "SELLER", userId: req.user!.id },
            orderId,
            reason: "SELLER_REFUND_OFFER",
            message: thread.message,
            evidenceUrls: thread.evidenceUrls,
            requestedKobo: requestedKobo ?? null
        })
        res.status(201).send({ dispute: await loadDisputeDetail(id, "SELLER") })
    } catch (error) {
        if (!sendDisputeError(error, res)) {
            throw error
        }
    }
}

export const withdrawSellerOffer = async (req: Request, res: Response) => {
    const disputeId = parseId(req.params.id)

    try {
        if (disputeId === null) {
            throw new DisputeRequestError(404, "Complaint not found")
        }

        await withdrawDispute({ disputeId, actor: { party: "SELLER", userId: req.user!.id } })
        res.send({ dispute: await loadDisputeDetail(disputeId, "SELLER") })
    } catch (error) {
        if (!sendDisputeError(error, res)) {
            throw error
        }
    }
}
