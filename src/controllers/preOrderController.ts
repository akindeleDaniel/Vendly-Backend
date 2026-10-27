import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import type { PreOrderStatus, Prisma } from "../generated/prisma/client.js"
import {
    answerPreOrder,
    cancelPreOrder,
    maximumNoteLength,
    parseNote,
    parseReadyAt,
    preOrderPageSize,
    preOrderViewInclude,
    PreOrderRequestError,
    requestPreOrder,
    toPreOrderViews
} from "../lib/preOrders.js"

const statuses: PreOrderStatus[] = ["REQUESTED", "APPROVED", "DECLINED", "EXPIRED", "CANCELLED", "USED"]

// The tabs on the buyer's and the seller's pre-order lists, and the key each one's count goes under.
const preOrderGroups = {
    waiting: { statuses: ["REQUESTED"], countKey: "waiting" },
    "to-pay": { statuses: ["APPROVED"], countKey: "toPay" },
    paid: { statuses: ["USED"], countKey: "paid" },
    ended: { statuses: ["DECLINED", "EXPIRED", "CANCELLED"], countKey: "ended" }
} satisfies Record<string, { statuses: PreOrderStatus[]; countKey: string }>

type PreOrderGroup = keyof typeof preOrderGroups

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

function sendPreOrderError(error: unknown, res: Response): boolean {
    if (error instanceof PreOrderRequestError) {
        res.status(error.statusCode).send({ message: error.message, ...(error.code ? { code: error.code } : {}), ...error.details })
        return true
    }

    return false
}

async function listFor(req: Request, res: Response, where: Prisma.PreOrderRequestWhereInput, viewer: "BUYER" | "SELLER") {
    const page = parsePage(req.query.page)
    const status = req.query.status === undefined ? undefined : statuses.find((candidate) => candidate === req.query.status) ?? null
    const group = req.query.group === undefined
        ? undefined
        : (Object.keys(preOrderGroups) as PreOrderGroup[]).find((candidate) => candidate === req.query.group) ?? null

    if (page === null) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    if (status === null) {
        res.status(400).send({ message: `Status must be one of ${statuses.join(", ")}` })
        return
    }

    if (group === null) {
        res.status(400).send({ message: "Group must be waiting, to-pay, paid or ended" })
        return
    }

    if (group && status) {
        res.status(400).send({ message: "Send either group or status, not both" })
        return
    }

    const filter: Prisma.PreOrderRequestWhereInput = {
        ...where,
        ...(status ? { status } : group ? { status: { in: preOrderGroups[group].statuses } } : {})
    }
    // The number on every tab, whichever one is open.
    const countsPromise = Promise.all([
        prisma.preOrderRequest.count({ where }),
        ...Object.values(preOrderGroups).map((tab) => prisma.preOrderRequest.count({ where: { ...where, status: { in: tab.statuses } } }))
    ]).then(([all, ...tabs]) => ({
        all,
        ...Object.fromEntries(Object.values(preOrderGroups).map((tab, index) => [tab.countKey, tabs[index] ?? 0]))
    }))
    // For the buyer's "waiting for payment" bar: approved requests they can still pay for.
    const awaitingPaymentPromise = viewer === "BUYER"
        ? prisma.preOrderRequest.count({ where: { ...where, status: "APPROVED", payBy: { gt: new Date() } } })
        : Promise.resolve(null)
    const [total, counts, awaitingPayment, records] = await Promise.all([
        prisma.preOrderRequest.count({ where: filter }),
        countsPromise,
        awaitingPaymentPromise,
        prisma.preOrderRequest.findMany({
            where: filter,
            include: preOrderViewInclude,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (page - 1) * preOrderPageSize,
            take: preOrderPageSize
        })
    ])

    res.send({
        page,
        pageSize: preOrderPageSize,
        total,
        counts,
        ...(awaitingPayment === null ? {} : { awaitingPayment }),
        preOrders: await toPreOrderViews(records, viewer)
    })
}

async function showFor(req: Request, res: Response, where: Prisma.PreOrderRequestWhereInput, viewer: "BUYER" | "SELLER") {
    const id = parseId(req.params.id)
    const record = id === null ? null : await prisma.preOrderRequest.findFirst({ where: { ...where, id }, include: preOrderViewInclude })

    if (!record) {
        res.status(404).send({ message: "Pre-order request not found" })
        return
    }

    res.send({ preOrder: (await toPreOrderViews([record], viewer))[0] })
}

// ---------------------------------------------------------------------------
// The buyer
// ---------------------------------------------------------------------------

// Asks a food shop to have what is in the buyer's cart from that shop ready at a time of their choosing.
export const askForPreOrder = async (req: Request, res: Response) => {
    const { sellerSlug } = req.body
    const readyAt = parseReadyAt(req.body.readyAt)
    const note = parseNote(req.body.note)

    if (typeof sellerSlug !== "string" || sellerSlug.length === 0 || sellerSlug.length > 200) {
        res.status(400).send({ message: "sellerSlug is required" })
        return
    }

    if (readyAt === null) {
        res.status(400).send({ message: "readyAt must be a date and time with its time zone, for example 2026-11-02T14:00:00+01:00" })
        return
    }

    if (note === null) {
        res.status(400).send({ message: `The note can be up to ${maximumNoteLength} characters` })
        return
    }

    try {
        const request = await requestPreOrder({ buyerId: req.user!.id, sellerSlug, readyAt, note })
        const record = await prisma.preOrderRequest.findUniqueOrThrow({ where: { id: request.id }, include: preOrderViewInclude })
        res.status(201).send({ preOrder: (await toPreOrderViews([record], "BUYER"))[0] })
    } catch (error) {
        if (!sendPreOrderError(error, res)) {
            throw error
        }
    }
}

export const listMyPreOrders = (req: Request, res: Response) => listFor(req, res, { buyerId: req.user!.id }, "BUYER")

export const getMyPreOrder = (req: Request, res: Response) => showFor(req, res, { buyerId: req.user!.id }, "BUYER")

export const cancelMyPreOrder = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)

    try {
        if (id === null) {
            throw new PreOrderRequestError(404, "Pre-order request not found")
        }

        await cancelPreOrder({ id, buyerId: req.user!.id })
        const record = await prisma.preOrderRequest.findUniqueOrThrow({ where: { id }, include: preOrderViewInclude })
        res.send({ preOrder: (await toPreOrderViews([record], "BUYER"))[0] })
    } catch (error) {
        if (!sendPreOrderError(error, res)) {
            throw error
        }
    }
}

// ---------------------------------------------------------------------------
// The seller
// ---------------------------------------------------------------------------

export const listSellerPreOrders = (req: Request, res: Response) => listFor(req, res, { sellerId: req.user!.id }, "SELLER")

export const getSellerPreOrder = (req: Request, res: Response) => showFor(req, res, { sellerId: req.user!.id }, "SELLER")

// How many requests are waiting for this seller's answer, for a notice on the site.
export const countPreOrdersAwaitingAnswer = async (req: Request, res: Response) => {
    const count = await prisma.preOrderRequest.count({ where: { sellerId: req.user!.id, status: "REQUESTED", respondBy: { gt: new Date() } } })
    res.send({ count })
}

const answer = (action: "APPROVE" | "DECLINE") => async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const note = parseNote(req.body.note)

    if (note === null) {
        res.status(400).send({ message: `The note can be up to ${maximumNoteLength} characters` })
        return
    }

    if (action === "DECLINE" && (note === undefined || note.length < 3)) {
        res.status(400).send({ message: "Tell the buyer why, in at least 3 characters" })
        return
    }

    try {
        if (id === null) {
            throw new PreOrderRequestError(404, "Pre-order request not found")
        }

        await answerPreOrder({ id, sellerId: req.user!.id, action, note })
        const record = await prisma.preOrderRequest.findUniqueOrThrow({ where: { id }, include: preOrderViewInclude })
        res.send({ preOrder: (await toPreOrderViews([record], "SELLER"))[0] })
    } catch (error) {
        if (!sendPreOrderError(error, res)) {
            throw error
        }
    }
}

export const approvePreOrder = answer("APPROVE")
export const declinePreOrder = answer("DECLINE")
