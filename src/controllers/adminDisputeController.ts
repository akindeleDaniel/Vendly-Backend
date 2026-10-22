import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import {
    activeDisputeStatuses,
    addDisputeMessage,
    disputeReasonLabels,
    DisputeRequestError,
    maximumEvidenceLinks,
    maximumMessageLength,
    minimumMessageLength,
    parseEvidenceUrls,
    parseMessageBody,
    parseNairaToKobo,
    rejectDispute,
    reopenDispute
} from "../lib/disputes.js"
import { issueRefund, RefundRequestError } from "../lib/payments/refunds.js"
import { listDisputes, loadDisputeDetail, showDispute } from "./disputeController.js"
import { notifyComplaintActivity, queueNotification } from "../lib/notifications.js"

const maximumShortTextLength = 300

function parseId(value: unknown): number | null {
    const id = Number(value)
    return Number.isSafeInteger(id) && id > 0 ? id : null
}

// A short required text: trimmed, at least minimumLength and at most 300 characters. Null when not acceptable.
function parseShortText(value: unknown, minimumLength = 3): string | null {
    if (typeof value !== "string") {
        return null
    }

    const text = value.trim()
    return text.length >= minimumLength && text.length <= maximumShortTextLength ? text : null
}

// An optional short text: null when left out, undefined when not acceptable.
function parseOptionalShortText(value: unknown): string | null | undefined {
    if (value === undefined || value === null || value === "") {
        return null
    }

    return parseShortText(value, 1) ?? undefined
}

function parseOptionalFlag(value: unknown): boolean | null | undefined {
    if (value === undefined || value === null) {
        return null
    }

    return typeof value === "boolean" ? value : undefined
}

function sendError(error: unknown, res: Response): boolean {
    if (error instanceof DisputeRequestError) {
        res.status(error.statusCode).send({ message: error.message, ...(error.code ? { code: error.code } : {}), ...error.details })
        return true
    }

    if (error instanceof RefundRequestError) {
        res.status(error.statusCode).send({ message: error.message, code: error.code, ...error.details })
        return true
    }

    return false
}

// Complaints that need an administrator: the seller agreed to a refund, or disagreed or did not
// answer in time. Pass ?status= to see others.
export const listAdminDisputes = (req: Request, res: Response) =>
    listDisputes(req, res, {}, ["SELLER_AGREED", "UNDER_REVIEW"])

export const getAdminDispute = (req: Request, res: Response) =>
    showDispute(res, parseId(req.params.id), {}, "ADMIN")

// An administrator writes to the shared thread, for example to ask either side for more detail.
export const postAdminDisputeMessage = async (req: Request, res: Response) => {
    const disputeId = parseId(req.params.id)
    const message = parseMessageBody(req.body.message)
    const evidenceUrls = parseEvidenceUrls(req.body.evidenceUrls)

    if (message === null || evidenceUrls === null) {
        res.status(400).send({
            message: message === null
                ? `A message of ${minimumMessageLength} to ${maximumMessageLength} characters is required`
                : `Evidence must be up to ${maximumEvidenceLinks} https links`
        })
        return
    }

    try {
        if (disputeId === null) {
            throw new DisputeRequestError(404, "Complaint not found")
        }

        await addDisputeMessage({ disputeId, actor: { party: "ADMIN", userId: req.user!.id }, message, evidenceUrls })
        res.status(201).send({ dispute: await loadDisputeDetail(disputeId, "ADMIN") })
    } catch (error) {
        if (!sendError(error, res)) {
            throw error
        }
    }
}

// Approves a complaint by refunding the order, which closes the complaint once the payment provider
// accepts the refund. The amount defaults to what the buyer asked for. The note is added to the thread
// for both sides. If the refund cannot be started, the complaint stays open so it can be approved again.
export const approveDispute = async (req: Request, res: Response) => {
    const disputeId = parseId(req.params.id)
    const note = parseMessageBody(req.body.note)
    const amountKobo = parseNairaToKobo(req.body.amount)
    const reason = req.body.reason === undefined ? undefined : parseShortText(req.body.reason)
    const customerNote = parseOptionalShortText(req.body.customerNote)
    const restock = parseOptionalFlag(req.body.restock)
    const chargeSeller = parseOptionalFlag(req.body.chargeSeller)
    const acknowledgeLowBalance = parseOptionalFlag(req.body.acknowledgeLowBalance)

    if (disputeId === null) {
        res.status(404).send({ message: "Complaint not found" })
        return
    }

    if (note === null) {
        res.status(400).send({ message: `A note of ${minimumMessageLength} to ${maximumMessageLength} characters is required` })
        return
    }

    if (amountKobo === null) {
        res.status(400).send({ message: "Amount must be a positive number with at most two decimal places" })
        return
    }

    if (reason === null || customerNote === undefined) {
        res.status(400).send({ message: `The reason and the note for the customer must be 3 to ${maximumShortTextLength} characters` })
        return
    }

    if (restock === undefined || chargeSeller === undefined || acknowledgeLowBalance === undefined) {
        res.status(400).send({ message: "restock, chargeSeller and acknowledgeLowBalance must be true or false" })
        return
    }

    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } })

    if (!dispute) {
        res.status(404).send({ message: "Complaint not found" })
        return
    }

    if (!activeDisputeStatuses.includes(dispute.status)) {
        res.status(409).send({ message: "This complaint is already closed", code: "DISPUTE_CLOSED" })
        return
    }

    try {
        const refund = await issueRefund({
            adminId: req.user!.id,
            target: { orderId: dispute.orderId },
            amountKobo: amountKobo ?? dispute.requestedAmount.times(100).toNumber(),
            reason: reason ?? `Complaint ${dispute.id}: ${disputeReasonLabels[dispute.reason]}`,
            customerNote,
            restock,
            chargeSeller,
            acknowledgeLowBalance: acknowledgeLowBalance ?? false,
            disputeId: dispute.id
        })

        // The refund has closed the complaint, so the note is written straight to the thread.
        await prisma.disputeMessage.create({
            data: { disputeId: dispute.id, author: "ADMIN", authorId: req.user!.id, body: note }
        })
        queueNotification("complaint approved", () => notifyComplaintActivity(dispute.id))

        res.status(201).send({
            dispute: await loadDisputeDetail(dispute.id, "ADMIN"),
            refund: { id: refund.id, reference: refund.reference, amount: refund.amount.toFixed(2), status: refund.status }
        })
    } catch (error) {
        if (!sendError(error, res)) {
            throw error
        }
    }
}

// Turns a complaint down. The note is read by both sides.
export const rejectAdminDispute = async (req: Request, res: Response) => {
    const disputeId = parseId(req.params.id)
    const note = parseMessageBody(req.body.note)

    if (note === null) {
        res.status(400).send({ message: `A note of ${minimumMessageLength} to ${maximumMessageLength} characters is required` })
        return
    }

    try {
        if (disputeId === null) {
            throw new DisputeRequestError(404, "Complaint not found")
        }

        await rejectDispute({ disputeId, adminId: req.user!.id, note })
        res.send({ dispute: await loadDisputeDetail(disputeId, "ADMIN") })
    } catch (error) {
        if (!sendError(error, res)) {
            throw error
        }
    }
}

// Reopens a complaint that was rejected, with a note both sides read.
export const reopenAdminDispute = async (req: Request, res: Response) => {
    const disputeId = parseId(req.params.id)
    const note = parseMessageBody(req.body.note)

    if (note === null) {
        res.status(400).send({ message: `A note of ${minimumMessageLength} to ${maximumMessageLength} characters is required` })
        return
    }

    try {
        if (disputeId === null) {
            throw new DisputeRequestError(404, "Complaint not found")
        }

        await reopenDispute({ disputeId, adminId: req.user!.id, note })
        res.send({ dispute: await loadDisputeDetail(disputeId, "ADMIN") })
    } catch (error) {
        if (!sendError(error, res)) {
            throw error
        }
    }
}
