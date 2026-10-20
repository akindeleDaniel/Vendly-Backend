import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { CookieOptions, Request, Response } from "express"
import jwt from "jsonwebtoken"
import prisma from "./prisma.js"
import { authCookieOptions } from "./authCookie.js"

// The access token proves who is calling and is short-lived, so a stolen one stops working quickly.
// The refresh token is long-lived, stored hashed, and swapped for a new pair each time it is used.
export const accessTokenTtlMs = 15 * 60 * 1000
export const refreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000
// A browser can send two refreshes at once (two requests failing together). The loser of that race
// presents a token that was swapped moments ago; that is refused without treating it as theft.
export const rotationGraceMs = 10 * 1000
const keepRevokedForMs = 7 * 24 * 60 * 60 * 1000

export const accessCookieName = "token"
export const refreshCookieName = "refreshToken"

// The refresh cookie is only sent to the account routes, never to ordinary requests.
const refreshCookiePath = "/users"
const refreshCookieOptions: CookieOptions = { ...authCookieOptions, path: refreshCookiePath }

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex")
}

function newRefreshSecret(): string {
    return randomBytes(32).toString("base64url")
}

// The token names the login it belongs to (sid), so ending that login stops the token at once.
function signAccessToken(userId: number, familyId: string): string {
    if (!process.env.JWT_SECRET) {
        throw new Error("JWT_SECRET is not set")
    }

    return jwt.sign({ id: userId, sid: familyId }, process.env.JWT_SECRET, { expiresIn: Math.floor(accessTokenTtlMs / 1000) })
}

function setSessionCookies(res: Response, userId: number, familyId: string, refreshSecret: string, refreshExpiresAt: Date) {
    res.cookie(accessCookieName, signAccessToken(userId, familyId), { ...authCookieOptions, maxAge: accessTokenTtlMs })
    res.cookie(refreshCookieName, refreshSecret, {
        ...refreshCookieOptions,
        maxAge: Math.max(refreshExpiresAt.getTime() - Date.now(), 0)
    })
}

export function clearSessionCookies(res: Response) {
    res.clearCookie(accessCookieName, authCookieOptions)
    res.clearCookie(refreshCookieName, refreshCookieOptions)
}

function describeDevice(req: Request): string | null {
    const userAgent = req.get("user-agent")
    return userAgent ? userAgent.slice(0, 200) : null
}

// Starts a new login on this device: a fresh family of refresh tokens and both cookies.
export async function startSession(req: Request, res: Response, userId: number, now = new Date()) {
    const refreshSecret = newRefreshSecret()
    const expiresAt = new Date(now.getTime() + refreshTokenTtlMs)
    const familyId = randomUUID()

    await prisma.refreshToken.create({
        data: {
            userId,
            familyId,
            tokenHash: hashToken(refreshSecret),
            userAgent: describeDevice(req),
            expiresAt
        }
    })
    setSessionCookies(res, userId, familyId, refreshSecret, expiresAt)
}

// Swaps a refresh token for a new access and refresh token. Returns the user's id, or null when the
// token is unknown, expired, revoked or reused (reuse revokes the whole family: the old token can only
// be presented again if someone copied it).
export async function refreshSession(req: Request, res: Response, now = new Date()): Promise<number | null> {
    const presented = req.cookies?.[refreshCookieName]

    if (typeof presented !== "string" || presented.length === 0) {
        return null
    }

    const tokenHash = hashToken(presented)
    // Only one request can win the swap, so two servers or two tabs never both succeed.
    const claimed = await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now, revokedReason: "ROTATED", lastUsedAt: now }
    })

    if (claimed.count !== 1) {
        const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } })
        const justRotated = existing?.revokedAt != null
            && now.getTime() - existing.revokedAt.getTime() <= rotationGraceMs

        if (existing && existing.revokedReason === "ROTATED" && !justRotated) {
            await prisma.refreshToken.updateMany({
                where: { familyId: existing.familyId, revokedAt: null },
                data: { revokedAt: now, revokedReason: "REUSE" }
            })
        }

        return null
    }

    const old = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash } })
    const refreshSecret = newRefreshSecret()

    await prisma.refreshToken.create({
        data: {
            userId: old.userId,
            familyId: old.familyId,
            tokenHash: hashToken(refreshSecret),
            userAgent: describeDevice(req) ?? old.userAgent,
            // The family keeps its original expiry, so a login cannot be extended forever.
            expiresAt: old.expiresAt
        }
    })
    setSessionCookies(res, old.userId, old.familyId, refreshSecret, old.expiresAt)
    return old.userId
}

// Ends this device's login (logout).
export async function endSession(req: Request, now = new Date()) {
    const presented = req.cookies?.[refreshCookieName]

    if (typeof presented !== "string" || presented.length === 0) {
        return
    }

    const token = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(presented) } })

    if (token) {
        await prisma.refreshToken.updateMany({
            where: { familyId: token.familyId, revokedAt: null },
            data: { revokedAt: now, revokedReason: "LOGOUT" }
        })
    }
}

// Ends every login of this user, on every device (log out everywhere, password change). Access tokens
// issued before now stop working at once, not when they expire.
export async function endAllSessions(userId: number, now = new Date()) {
    await prisma.$transaction([
        prisma.refreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: now, revokedReason: "LOGOUT_ALL" }
        }),
        prisma.user.update({ where: { id: userId }, data: { sessionsValidFrom: now } })
    ])
}

// Whether an access token still belongs to a live login of an existing user. Checked on every request,
// so logout, log out everywhere and reuse detection take effect immediately. A token without a login
// id (issued before sessions existed) is only checked against "log out everywhere".
export async function isAccessTokenLive(userId: number, loginId: unknown, issuedAtSeconds: unknown, now = new Date()): Promise<boolean> {
    const [user, liveLogin] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { sessionsValidFrom: true } }),
        typeof loginId === "string"
            ? prisma.refreshToken.findFirst({
                where: { familyId: loginId, userId, revokedAt: null, expiresAt: { gt: now } },
                select: { id: true }
            })
            : Promise.resolve(true)
    ])

    if (!user || !liveLogin) {
        return false
    }

    if (user.sessionsValidFrom && typeof issuedAtSeconds === "number") {
        // Tokens carry whole seconds, so compare in whole seconds.
        return issuedAtSeconds >= Math.floor(user.sessionsValidFrom.getTime() / 1000)
    }

    return true
}

// Removes tokens that expired or were revoked more than a week ago. Called by the background check.
export async function purgeOldRefreshTokens(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - keepRevokedForMs)
    const result = await prisma.refreshToken.deleteMany({
        where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] }
    })
    return result.count
}
