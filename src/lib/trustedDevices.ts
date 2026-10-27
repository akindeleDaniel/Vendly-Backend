import { createHash, randomBytes } from "node:crypto"
import type { CookieOptions, Request, Response } from "express"
import prisma from "./prisma.js"
import { authCookieOptions } from "./authCookie.js"

// A browser that entered a login code is trusted for 30 days from that moment (fixed, not renewed by use),
// so ordinary users enter a code about once a month per device. Administrators are never trusted.
export const trustedDeviceTtlMs = 30 * 24 * 60 * 60 * 1000
export const trustedDeviceCookieName = "trustedDevice"
// One browser can be trusted by several accounts (people who switch between accounts), each with its own secret.
// The cookie holds the secrets separated by dots; base64url never contains a dot.
export const maximumTrustedAccountsPerBrowser = 5
const secretPattern = /^[A-Za-z0-9_-]{1,100}$/

const trustedDeviceCookieOptions: CookieOptions = { ...authCookieOptions, path: "/users" }

function hashSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("hex")
}

// The secrets this browser presents, ignoring anything malformed.
function presentedSecrets(req: Request): string[] {
    const value = req.cookies?.[trustedDeviceCookieName]

    if (typeof value !== "string" || value.length === 0) {
        return []
    }

    return [...new Set(value.split(".").filter((secret) => secretPattern.test(secret)))].slice(-maximumTrustedAccountsPerBrowser * 2)
}

export async function trustThisDevice(req: Request, res: Response, userId: number, now = new Date()) {
    const secret = randomBytes(32).toString("base64url")
    const expiresAt = new Date(now.getTime() + trustedDeviceTtlMs)
    const userAgent = req.get("user-agent")

    // Keep the other accounts' secrets that still work; this account's old one is replaced by the new one.
    const existing = presentedSecrets(req)
    const stillValid = existing.length === 0 ? [] : await prisma.trustedDevice.findMany({
        where: { tokenHash: { in: existing.map(hashSecret) }, userId: { not: userId }, revokedAt: null, expiresAt: { gt: now } },
        select: { tokenHash: true }
    })
    const validHashes = new Set(stillValid.map((device) => device.tokenHash))
    const kept = existing.filter((presented) => validHashes.has(hashSecret(presented))).slice(-(maximumTrustedAccountsPerBrowser - 1))

    await prisma.trustedDevice.create({
        data: { userId, tokenHash: hashSecret(secret), userAgent: userAgent ? userAgent.slice(0, 200) : null, expiresAt }
    })
    res.cookie(trustedDeviceCookieName, [...kept, secret].join("."), { ...trustedDeviceCookieOptions, maxAge: trustedDeviceTtlMs })
}

// Whether this request comes from a browser this user has trusted and that has not expired or been revoked.
export async function isTrustedDevice(req: Request, userId: number, now = new Date()): Promise<boolean> {
    const presented = presentedSecrets(req)

    if (presented.length === 0) {
        return false
    }

    const updated = await prisma.trustedDevice.updateMany({
        where: { tokenHash: { in: presented.map(hashSecret) }, userId, revokedAt: null, expiresAt: { gt: now } },
        data: { lastUsedAt: now }
    })

    return updated.count > 0
}
