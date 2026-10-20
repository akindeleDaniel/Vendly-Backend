import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma, type LiabilityStatus, type PaymentRecoveryStatus, type RefundStatus } from "../generated/prisma/client.js"
import { PaymentProviderError } from "../lib/payments/types.js"
import { issueRefund, RefundRequestError, syncRefund } from "../lib/payments/refunds.js"
import type { IssueRefundInput } from "../lib/payments/refunds.js"

const pageSize = 20
const maximumTextLength = 300
const refundStatuses: RefundStatus[] = ["PENDING", "PROCESSING", "NEEDS_ATTENTION", "SUCCEEDED", "FAILED"]
const liabilityStatuses: LiabilityStatus[] = ["OPEN", "CLEARED", "WRITTEN_OFF", "VOID"]
const recoveryStatuses: PaymentRecoveryStatus[] = ["OPEN", "RESOLVED"]

function money(amount: Prisma.Decimal): string {
    return amount.toFixed(2)
}

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

function parseFilter<T extends string>(value: unknown, allowed: T[]): T | undefined | null {
    if (value === undefined) {
        return undefined
    }

    return allowed.find((candidate) => candidate === value) ?? null
}

// An amount in naira with at most two decimals, as kobo. Undefined means "not supplied", null means invalid.
function parseAmountKobo(value: unknown): number | undefined | null {
    if (value === undefined || value === null) {
        return undefined
    }

    if (typeof value !== "number" && typeof value !== "string") {
        return null
    }

    const text = String(value).trim()

    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
        return null
    }

    const kobo = new Prisma.Decimal(text).times(100).toNumber()
    return Number.isSafeInteger(kobo) && kobo > 0 ? kobo : null
}

// A required text field, trimmed. Null when it is missing, blank or too long.
function parseText(value: unknown, minimumLength = 3): string | null {
    if (typeof value !== "string") {
        return null
    }

    const text = value.trim()
    return text.length >= minimumLength && text.length <= maximumTextLength ? text : null
}

function parseOptionalText(value: unknown): string | null | undefined {
    if (value === undefined || value === null || value === "") {
        return null
    }

    return parseText(value, 1) ?? undefined
}

function parseOptionalBoolean(value: unknown): boolean | null | undefined {
    if (value === undefined || value === null) {
        return null
    }

    return typeof value === "boolean" ? value : undefined
}

function sendRefundError(error: unknown, res: Response): boolean {
    if (error instanceof RefundRequestError) {
        res.status(error.statusCode).send({ message: error.message, code: error.code, ...error.details })
        return true
    }

    return false
}

const refundInclude = {
    paymentAttempt: { select: { reference: true } },
    liability: { select: { id: true, amount: true, recovered: true, status: true } }
} satisfies Prisma.RefundInclude

type RefundWithRelations = Prisma.RefundGetPayload<{ include: typeof refundInclude }>

function toRefundResponse(refund: RefundWithRelations) {
    return {
        id: refund.id,
        reference: refund.reference,
        orderId: refund.orderId,
        paymentReference: refund.paymentAttempt.reference,
        provider: refund.provider,
        amount: money(refund.amount),
        currency: refund.currency,
        status: refund.status,
        providerRefundId: refund.providerRefundId,
        providerStatus: refund.providerStatus,
        awaitingFunds: refund.awaitingFunds,
        expectedAt: refund.expectedAt,
        reason: refund.reason,
        customerNote: refund.customerNote,
        restock: refund.restock,
        restockedAt: refund.restockedAt,
        chargeSeller: refund.chargeSeller,
        failureReason: refund.failureReason,
        createdAt: refund.createdAt,
        completedAt: refund.completedAt,
        liability: refund.liability
            ? {
                id: refund.liability.id,
                amount: money(refund.liability.amount),
                recovered: money(refund.liability.recovered),
                status: refund.liability.status
            }
            : null
    }
}

async function loadRefund(id: number) {
    return prisma.refund.findUnique({ where: { id }, include: refundInclude })
}

// Reads the body of a refund request. Returns the problem as a message when something is invalid.
function parseRefundOptions(body: Record<string, unknown>, defaultReason?: string) {
    const reason = body.reason === undefined && defaultReason ? defaultReason : parseText(body.reason)
    const amountKobo = parseAmountKobo(body.amount)
    const customerNote = parseOptionalText(body.customerNote)
    const restock = parseOptionalBoolean(body.restock)
    const chargeSeller = parseOptionalBoolean(body.chargeSeller)
    const acknowledgeLowBalance = parseOptionalBoolean(body.acknowledgeLowBalance)

    if (reason === null) {
        return { error: `A reason of 3 to ${maximumTextLength} characters is required` }
    }

    if (amountKobo === null) {
        return { error: "Amount must be a positive number with at most two decimal places" }
    }

    if (customerNote === undefined) {
        return { error: `The note for the customer must be at most ${maximumTextLength} characters` }
    }

    if (restock === undefined || chargeSeller === undefined || acknowledgeLowBalance === undefined) {
        return { error: "restock, chargeSeller and acknowledgeLowBalance must be true or false" }
    }

    return {
        options: {
            reason,
            amountKobo: amountKobo ?? null,
            customerNote,
            restock,
            chargeSeller,
            acknowledgeLowBalance: acknowledgeLowBalance ?? false
        } satisfies Pick<IssueRefundInput, "reason" | "amountKobo" | "customerNote" | "restock" | "chargeSeller" | "acknowledgeLowBalance">
    }
}

// Refunds one seller's order, in full or in part, through the provider that took the payment.
export const issueOrderRefund = async (req: Request, res: Response) => {
    const orderId = parseId(req.params.id)
    const parsed = parseRefundOptions(req.body)

    if (orderId === null) {
        res.status(404).send({ message: "Order not found" })
        return
    }

    if (!parsed.options) {
        res.status(400).send({ message: parsed.error })
        return
    }

    try {
        const refund = await issueRefund({ adminId: req.user!.id, target: { orderId }, ...parsed.options })
        res.status(201).send({ refund: toRefundResponse((await loadRefund(refund.id))!) })
    } catch (error) {
        if (!sendRefundError(error, res)) {
            throw error
        }
    }
}

export const listRefunds = async (req: Request, res: Response) => {
    const page = parsePage(req.query.page)
    const status = parseFilter(req.query.status, refundStatuses)

    if (page === null) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    if (status === null) {
        res.status(400).send({ message: `Status must be one of ${refundStatuses.join(", ")}` })
        return
    }

    const where: Prisma.RefundWhereInput = status ? { status } : {}
    const [total, refunds] = await Promise.all([
        prisma.refund.count({ where }),
        prisma.refund.findMany({
            where,
            include: refundInclude,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (page - 1) * pageSize,
            take: pageSize
        })
    ])

    res.send({ page, pageSize, total, refunds: refunds.map(toRefundResponse) })
}

export const getRefund = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const refund = id === null ? null : await loadRefund(id)

    if (!refund) {
        res.status(404).send({ message: "Refund not found" })
        return
    }

    res.send({ refund: toRefundResponse(refund) })
}

// Asks the provider where a refund stands right now.
export const syncRefundNow = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const refund = id === null ? null : await prisma.refund.findUnique({ where: { id }, select: { id: true } })

    if (!refund) {
        res.status(404).send({ message: "Refund not found" })
        return
    }

    try {
        await syncRefund(refund.id)
    } catch (error) {
        if (error instanceof PaymentProviderError) {
            res.status(502).send({ message: "The payment provider could not be reached. Try again.", code: "REFUND_PROVIDER_UNAVAILABLE" })
            return
        }

        throw error
    }

    res.send({ refund: toRefundResponse((await loadRefund(refund.id))!) })
}

const recoveryCaseInclude = {
    paymentAttempt: {
        select: {
            reference: true,
            provider: true,
            amount: true,
            currency: true,
            checkout: { select: { id: true, user: { select: { name: true, email: true } } } }
        }
    }
} satisfies Prisma.PaymentRecoveryCaseInclude

function toRecoveryCaseResponse(recoveryCase: Prisma.PaymentRecoveryCaseGetPayload<{ include: typeof recoveryCaseInclude }>) {
    const { paymentAttempt } = recoveryCase

    return {
        id: recoveryCase.id,
        status: recoveryCase.status,
        reason: recoveryCase.reason,
        resolutionNote: recoveryCase.resolutionNote,
        createdAt: recoveryCase.createdAt,
        resolvedAt: recoveryCase.resolvedAt,
        payment: {
            id: recoveryCase.paymentAttemptId,
            reference: paymentAttempt.reference,
            provider: paymentAttempt.provider,
            amount: money(paymentAttempt.amount),
            currency: paymentAttempt.currency,
            checkoutId: paymentAttempt.checkout.id,
            buyer: paymentAttempt.checkout.user
        }
    }
}

// Payments that were verified but could not be completed into orders, waiting for a person.
export const listRecoveryCases = async (req: Request, res: Response) => {
    const status = parseFilter(req.query.status, recoveryStatuses)

    if (status === null) {
        res.status(400).send({ message: `Status must be one of ${recoveryStatuses.join(", ")}` })
        return
    }

    const cases = await prisma.paymentRecoveryCase.findMany({
        where: { status: status ?? "OPEN" },
        include: recoveryCaseInclude,
        orderBy: { id: "desc" },
        take: 100
    })

    res.send({ cases: cases.map(toRecoveryCaseResponse) })
}

// Refunds the whole payment behind a recovery case. The case closes once the refund completes.
export const refundRecoveryCase = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const parsed = parseRefundOptions(req.body, "The order could not be completed after payment")
    const recoveryCase = id === null ? null : await prisma.paymentRecoveryCase.findUnique({ where: { id } })

    if (!recoveryCase) {
        res.status(404).send({ message: "Recovery case not found" })
        return
    }

    if (!parsed.options) {
        res.status(400).send({ message: parsed.error })
        return
    }

    if (recoveryCase.status !== "OPEN") {
        res.status(409).send({ message: "This recovery case is already resolved", code: "REFUND_NOT_ALLOWED" })
        return
    }

    try {
        const refund = await issueRefund({
            adminId: req.user!.id,
            target: { paymentAttemptId: recoveryCase.paymentAttemptId },
            ...parsed.options,
            restock: false,
            chargeSeller: false
        })
        res.status(201).send({ refund: toRefundResponse((await loadRefund(refund.id))!) })
    } catch (error) {
        if (!sendRefundError(error, res)) {
            throw error
        }
    }
}

// Closes a recovery case that was dealt with another way, for example by fulfilling the order by hand.
export const resolveRecoveryCase = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const note = parseText(req.body.note)

    if (id === null) {
        res.status(404).send({ message: "Recovery case not found" })
        return
    }

    if (note === null) {
        res.status(400).send({ message: `A note of 3 to ${maximumTextLength} characters is required` })
        return
    }

    const closed = await prisma.paymentRecoveryCase.updateMany({
        where: { id, status: "OPEN" },
        data: { status: "RESOLVED", resolutionNote: note, resolvedAt: new Date() }
    })

    if (closed.count === 0) {
        const existing = await prisma.paymentRecoveryCase.findUnique({ where: { id }, select: { id: true } })

        res.status(existing ? 409 : 404).send({
            message: existing ? "This recovery case is already resolved" : "Recovery case not found"
        })
        return
    }

    const resolved = await prisma.paymentRecoveryCase.findUniqueOrThrow({ where: { id }, include: recoveryCaseInclude })
    res.send({ case: toRecoveryCaseResponse(resolved) })
}

const liabilityInclude = {
    seller: { select: { name: true, email: true } },
    refund: { select: { reference: true, orderId: true, reason: true, status: true } },
    recoveries: { orderBy: { id: "asc" }, select: { orderId: true, amount: true, note: true, createdAt: true } }
} satisfies Prisma.SellerLiabilityInclude

function toLiabilityResponse(liability: Prisma.SellerLiabilityGetPayload<{ include: typeof liabilityInclude }>) {
    return {
        id: liability.id,
        sellerId: liability.sellerId,
        seller: liability.seller,
        orderId: liability.refund.orderId,
        refundReference: liability.refund.reference,
        refundStatus: liability.refund.status,
        reason: liability.refund.reason,
        amount: money(liability.amount),
        recovered: money(liability.recovered),
        remaining: money(liability.amount.minus(liability.recovered)),
        status: liability.status,
        note: liability.note,
        createdAt: liability.createdAt,
        closedAt: liability.closedAt,
        recoveries: liability.recoveries.map((recovery) => ({
            orderId: recovery.orderId,
            amount: money(recovery.amount),
            note: recovery.note,
            createdAt: recovery.createdAt
        }))
    }
}

// What sellers owe Vendly for refunds, with each deduction taken so far.
export const listLiabilities = async (req: Request, res: Response) => {
    const status = parseFilter(req.query.status, liabilityStatuses)
    const sellerId = req.query.sellerId === undefined ? undefined : parseId(req.query.sellerId)

    if (status === null) {
        res.status(400).send({ message: `Status must be one of ${liabilityStatuses.join(", ")}` })
        return
    }

    if (sellerId === null) {
        res.status(400).send({ message: "Seller ID must be a positive whole number" })
        return
    }

    const liabilities = await prisma.sellerLiability.findMany({
        where: { status: status ?? "OPEN", ...(sellerId ? { sellerId } : {}) },
        include: liabilityInclude,
        orderBy: { id: "desc" },
        take: 100
    })

    res.send({ liabilities: liabilities.map(toLiabilityResponse) })
}

// Records money collected from a seller by hand (for example a bank transfer), against a liability.
export const recordManualRecovery = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const amountKobo = parseAmountKobo(req.body.amount)
    const note = parseText(req.body.note)

    if (id === null) {
        res.status(404).send({ message: "Liability not found" })
        return
    }

    if (amountKobo === undefined || amountKobo === null) {
        res.status(400).send({ message: "Amount must be a positive number with at most two decimal places" })
        return
    }

    if (note === null) {
        res.status(400).send({ message: `A note of 3 to ${maximumTextLength} characters is required` })
        return
    }

    const outcome = await prisma.$transaction(async (tx) => {
        const liability = await tx.sellerLiability.findUnique({ where: { id } })

        if (!liability) {
            return "not-found" as const
        }

        const remaining = liability.amount.minus(liability.recovered)
        const amount = new Prisma.Decimal(amountKobo).dividedBy(100)

        if (liability.status !== "OPEN" || amount.greaterThan(remaining)) {
            return { refused: remaining.toFixed(2), open: liability.status === "OPEN" }
        }

        await tx.liabilityRecovery.create({ data: { liabilityId: id, orderId: null, amount, note } })
        const updated = await tx.sellerLiability.update({ where: { id }, data: { recovered: { increment: amount } } })

        if (updated.recovered.greaterThanOrEqualTo(updated.amount)) {
            await tx.sellerLiability.update({ where: { id }, data: { status: "CLEARED", closedAt: new Date() } })
        }

        return "recorded" as const
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    if (outcome === "not-found") {
        res.status(404).send({ message: "Liability not found" })
        return
    }

    if (outcome !== "recorded") {
        res.status(409).send({
            message: outcome.open
                ? `The amount is more than the ₦${outcome.refused} still owed`
                : "This liability is no longer open",
            code: "LIABILITY_NOT_OPEN"
        })
        return
    }

    res.send({ liability: toLiabilityResponse(await prisma.sellerLiability.findUniqueOrThrow({ where: { id }, include: liabilityInclude })) })
}

// Gives up on collecting what is left of a liability.
export const writeOffLiability = async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const note = parseText(req.body.note)

    if (id === null) {
        res.status(404).send({ message: "Liability not found" })
        return
    }

    if (note === null) {
        res.status(400).send({ message: `A note of 3 to ${maximumTextLength} characters is required` })
        return
    }

    const closed = await prisma.sellerLiability.updateMany({
        where: { id, status: "OPEN" },
        data: { status: "WRITTEN_OFF", note, closedAt: new Date() }
    })

    if (closed.count === 0) {
        const existing = await prisma.sellerLiability.findUnique({ where: { id }, select: { id: true } })

        res.status(existing ? 409 : 404).send({
            message: existing ? "This liability is no longer open" : "Liability not found",
            ...(existing ? { code: "LIABILITY_NOT_OPEN" } : {})
        })
        return
    }

    res.send({ liability: toLiabilityResponse(await prisma.sellerLiability.findUniqueOrThrow({ where: { id }, include: liabilityInclude })) })
}
