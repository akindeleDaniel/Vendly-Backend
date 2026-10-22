import type { Request, Response } from "express"
import { AdminTeamError, confirmActorPassword, grantAdmin, listAuditLog, listTeam, revokeAdmin, setSuperAdmin } from "../lib/adminTeam.js"

function parseUserId(value: unknown): number | null {
    return typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2_147_483_647 ? Number(value) : null
}

function sendTeamError(error: unknown, res: Response): boolean {
    if (error instanceof AdminTeamError) {
        res.status(error.status).send({ message: error.message, ...(error.code ? { code: error.code } : {}) })
        return true
    }

    return false
}

export const getTeam = async (_req: Request, res: Response) => {
    res.send({ team: await listTeam() })
}

// Makes an existing, email-confirmed account an administrator (or a super administrator with superAdmin: true).
export const addAdmin = async (req: Request, res: Response) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : ""

    if (!email || email.length > 254) {
        res.status(400).send({ message: "Enter the email of the account" })
        return
    }

    if (req.body.superAdmin !== undefined && typeof req.body.superAdmin !== "boolean") {
        res.status(400).send({ message: "superAdmin must be true or false" })
        return
    }

    try {
        await confirmActorPassword(req.user!.id, req.body.password)
        await grantAdmin(req.user!.id, email, req.body.superAdmin === true)
        res.status(201).send({ team: await listTeam() })
    } catch (error) {
        if (!sendTeamError(error, res)) {
            throw error
        }
    }
}

export const removeAdmin = async (req: Request, res: Response) => {
    const targetId = parseUserId(req.params.userId)

    try {
        if (targetId === null) {
            throw new AdminTeamError(404, "That person is not an administrator")
        }

        await confirmActorPassword(req.user!.id, req.body?.password)
        await revokeAdmin(req.user!.id, targetId)
        res.send({ team: await listTeam() })
    } catch (error) {
        if (!sendTeamError(error, res)) {
            throw error
        }
    }
}

// Makes an administrator a super administrator (value: true) or takes that level away (value: false).
export const changeSuperAdmin = async (req: Request, res: Response) => {
    const targetId = parseUserId(req.params.userId)

    if (typeof req.body?.value !== "boolean") {
        res.status(400).send({ message: "value must be true or false" })
        return
    }

    try {
        if (targetId === null) {
            throw new AdminTeamError(404, "That person is not an administrator")
        }

        await confirmActorPassword(req.user!.id, req.body.password)
        await setSuperAdmin(req.user!.id, targetId, req.body.value)
        res.send({ team: await listTeam() })
    } catch (error) {
        if (!sendTeamError(error, res)) {
            throw error
        }
    }
}

export const getAuditLog = async (req: Request, res: Response) => {
    const raw = req.query.page
    const page = raw === undefined ? 1 : typeof raw === "string" && /^[1-9]\d{0,6}$/.test(raw) ? Number(raw) : null

    if (page === null) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    res.send(await listAuditLog(page))
}
