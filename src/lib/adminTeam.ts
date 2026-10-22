import bcrypt from "bcrypt"
import prisma from "./prisma.js"
import type { Prisma } from "../generated/prisma/client.js"
import { notifyAdminChange, queueNotification } from "./notifications.js"

export type AdminAction = "ADMIN_GRANTED" | "ADMIN_REVOKED" | "SUPER_ADMIN_GRANTED" | "SUPER_ADMIN_REMOVED" | "SELLER_BLOCKED" | "SELLER_UNBLOCKED"

export class AdminTeamError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
        super(message)
    }
}

// Writes one line of the audit log. Called after the change it records has been saved.
export async function logAdminAction(actorId: number, action: AdminAction, targetUserId: number | null, detail?: string): Promise<void> {
    try {
        await prisma.adminAuditLog.create({ data: { actorId, action, targetUserId, detail: detail ?? null } })
    } catch (error) {
        console.error("Could not write the audit log", { action, reason: error instanceof Error ? error.message : undefined })
    }
}

// Changing who the administrators are is what someone with a stolen session would try, so the person doing it
// confirms with their own password every time.
export async function confirmActorPassword(actorId: number, password: unknown): Promise<void> {
    if (typeof password !== "string" || !password) {
        throw new AdminTeamError(400, "Enter your password to confirm")
    }

    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { passwordHash: true } })

    if (!actor?.passwordHash) {
        throw new AdminTeamError(403, "Set a password on your account before managing the team", "ADMIN_PASSWORD_REQUIRED")
    }

    if (!await bcrypt.compare(password, actor.passwordHash)) {
        throw new AdminTeamError(403, "That password is not correct")
    }
}

const teamSelect = { id: true, name: true, email: true, isSuperAdmin: true, createdAt: true } satisfies Prisma.UserSelect

export async function listTeam() {
    return prisma.user.findMany({ where: { isAdmin: true }, select: teamSelect, orderBy: [{ isSuperAdmin: "desc" }, { id: "asc" }] })
}

// Runs a change to the team with the super administrators locked, so two changes at once cannot remove the last one.
async function changeTeam<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE "isSuperAdmin" = true FOR UPDATE`
        return work(tx)
    })
}

export async function grantAdmin(actorId: number, email: string, makeSuper: boolean): Promise<void> {
    const target = await changeTeam(async (tx) => {
        const user = await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true, isAdmin: true, emailVerifiedAt: true } })

        if (!user) {
            throw new AdminTeamError(404, "No account has that email")
        }

        if (user.isAdmin) {
            throw new AdminTeamError(409, "That person is already an administrator")
        }

        if (!user.emailVerifiedAt) {
            throw new AdminTeamError(409, "That account has not confirmed its email yet")
        }

        await tx.user.update({ where: { id: user.id }, data: { isAdmin: true, isSuperAdmin: makeSuper } })
        return user
    })

    await logAdminAction(actorId, makeSuper ? "SUPER_ADMIN_GRANTED" : "ADMIN_GRANTED", target.id, makeSuper ? "Made a super administrator" : "Made an administrator")
    queueNotification("admin granted", () => notifyAdminChange(target.id, makeSuper ? "SUPER_GRANTED" : "GRANTED"))
}

export async function revokeAdmin(actorId: number, targetId: number): Promise<void> {
    await changeTeam(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: targetId }, select: { isAdmin: true, isSuperAdmin: true } })

        if (!user?.isAdmin) {
            throw new AdminTeamError(404, "That person is not an administrator")
        }

        if (user.isSuperAdmin && (await tx.user.count({ where: { isSuperAdmin: true } })) <= 1) {
            throw new AdminTeamError(409, "The last super administrator cannot be removed", "LAST_SUPER_ADMIN")
        }

        await tx.user.update({ where: { id: targetId }, data: { isAdmin: false, isSuperAdmin: false } })
    })

    await logAdminAction(actorId, "ADMIN_REVOKED", targetId, "Administrator access removed")
    queueNotification("admin revoked", () => notifyAdminChange(targetId, "REVOKED"))
}

// Makes an administrator a super administrator, or takes that level away (they stay an administrator).
export async function setSuperAdmin(actorId: number, targetId: number, value: boolean): Promise<void> {
    await changeTeam(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: targetId }, select: { isAdmin: true, isSuperAdmin: true } })

        if (!user?.isAdmin) {
            throw new AdminTeamError(404, "That person is not an administrator")
        }

        if (user.isSuperAdmin === value) {
            throw new AdminTeamError(409, value ? "That person is already a super administrator" : "That person is not a super administrator")
        }

        if (!value && (await tx.user.count({ where: { isSuperAdmin: true } })) <= 1) {
            throw new AdminTeamError(409, "The last super administrator cannot be removed", "LAST_SUPER_ADMIN")
        }

        await tx.user.update({ where: { id: targetId }, data: { isSuperAdmin: value } })
    })

    await logAdminAction(actorId, value ? "SUPER_ADMIN_GRANTED" : "SUPER_ADMIN_REMOVED", targetId, value ? "Made a super administrator" : "No longer a super administrator")
    queueNotification("admin changed", () => notifyAdminChange(targetId, value ? "SUPER_GRANTED" : "SUPER_REMOVED"))
}

export const auditPageSize = 50

export async function listAuditLog(page: number) {
    const [total, rows] = await Promise.all([
        prisma.adminAuditLog.count(),
        prisma.adminAuditLog.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * auditPageSize, take: auditPageSize })
    ])
    const ids = [...new Set(rows.flatMap((row) => [row.actorId, ...(row.targetUserId === null ? [] : [row.targetUserId])]))]
    const people = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })).map((person) => [person.id, person]))
    const person = (id: number | null) => (id === null ? null : people.get(id) ?? { id, name: "Deleted account", email: null })

    return {
        page,
        pageSize: auditPageSize,
        total,
        entries: rows.map((row) => ({ id: row.id, action: row.action, actor: person(row.actorId), target: person(row.targetUserId), detail: row.detail, createdAt: row.createdAt }))
    }
}
