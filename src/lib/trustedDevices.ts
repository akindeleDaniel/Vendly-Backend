import { createHash, randomBytes } from "node:crypto"
import type { CookieOptions, Request, Response } from "express"
import prisma from "./prisma.js"
import { authCookieOptions } from "./authCookie.js"

// A browser that entered a login code is trusted for 30 days from that moment (fixed, not renewed by use),
// so ordinary users enter a code about once a month per device. Administrators are never trusted.
export const trustedDeviceTtlMs = 30 * 24 * 60 * 60 * 1000
export const trustedDeviceCookieName = "trustedDevice"

const trustedDeviceCookieOptions: CookieOptions = { ...authCookieOptions, path: "/users" }

function hashSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("hex")
}

export async function trustThisDevice(req: Request, res: Response, userId: number, now = new Date()) {
    const secret = randomBytes(32).toString("base64url")
    const expiresAt = new Date(now.getTime() + trustedDeviceTtlMs)
    const userAgent = req.get("user-agent")

    await prisma.trustedDevice.create({
        data: { userId, tokenHash: hashSecret(secret), userAgent: userAgent ? userAgent.slice(0, 200) : null, expiresAt }
    })
    res.cookie(trustedDeviceCookieName, secret, { ...trustedDeviceCookieOptions, maxAge: trustedDeviceTtlMs })
}

// Whether this request comes from a browser this user has trusted and that has not expired or been revoked.
export async function isTrustedDevice(req: Request, userId: number, now = new Date()): Promise<boolean> {
    const presented = req.cookies?.[trustedDeviceCookieName]

    if (typeof presented !== "string" || presented.length === 0) {
        return false
    }

    const updated = await prisma.trustedDevice.updateMany({
        where: { tokenHash: hashSecret(presented), userId, revokedAt: null, expiresAt: { gt: now } },
        data: { lastUsedAt: now }
    })

    return updated.count === 1
}
