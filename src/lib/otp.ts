import { createHmac, randomInt, timingSafeEqual } from "node:crypto"
import type { OtpPurpose } from "../generated/prisma/client.js"
import prisma from "./prisma.js"
import { sendEmail } from "./email/index.js"
import { otpEmail } from "./email/templates.js"

export const otpTtlMs = 10 * 60 * 1000
// One code per minute: asking again sooner leaves the code already sent in place.
export const otpResendCooldownMs = 60 * 1000
export const otpMaxAttempts = 5
// Codes emailed to one account in 24 hours, across all purposes.
export const otpDailyLimit = 10

export type OtpIssueResult = "sent" | "cooldown" | "limit"

function hashCode(userId: number, purpose: OtpPurpose, code: string): string {
    const secret = process.env.JWT_SECRET

    if (!secret) {
        throw new Error("JWT_SECRET is not set")
    }

    return createHmac("sha256", secret).update(`otp:${userId}:${purpose}:${code}`).digest("hex")
}

// Emails a new code, replacing any earlier unused code for the same purpose. Does nothing when the last
// code is under a minute old and still unused, or when the account has had too many codes today.
export async function issueOtp(user: { id: number; email: string }, purpose: OtpPurpose, now = new Date()): Promise<OtpIssueResult> {
    const latest = await prisma.emailOtp.findFirst({ where: { userId: user.id, purpose }, orderBy: { id: "desc" } })

    if (latest && !latest.consumedAt && latest.expiresAt > now && now.getTime() - latest.createdAt.getTime() < otpResendCooldownMs) {
        return "cooldown"
    }

    const sentToday = await prisma.emailOtp.count({
        where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }
    })

    if (sentToday >= otpDailyLimit) {
        return "limit"
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, "0")
    const created = await prisma.$transaction(async (tx) => {
        await tx.emailOtp.updateMany({ where: { userId: user.id, purpose, consumedAt: null }, data: { consumedAt: now } })
        return tx.emailOtp.create({
            data: { userId: user.id, purpose, codeHash: hashCode(user.id, purpose, code), expiresAt: new Date(now.getTime() + otpTtlMs) }
        })
    })

    try {
        await sendEmail(otpEmail(user.email, purpose, code, otpTtlMs / 60000))
    } catch (error) {
        // The code never reached the person, so it should not block the next request.
        await prisma.emailOtp.update({ where: { id: created.id }, data: { consumedAt: now } })
        throw error
    }

    return "sent"
}

// Checks a code. Each wrong guess is counted before the comparison, so five wrong guesses kill the code
// however fast they arrive. A right code works once.
export async function checkOtp(userId: number, purpose: OtpPurpose, code: unknown, now = new Date()): Promise<boolean> {
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
        return false
    }

    const otp = await prisma.emailOtp.findFirst({
        where: { userId, purpose, consumedAt: null, expiresAt: { gt: now } },
        orderBy: { id: "desc" }
    })

    if (!otp) {
        return false
    }

    const counted = await prisma.emailOtp.updateMany({
        where: { id: otp.id, consumedAt: null, attempts: { lt: otpMaxAttempts } },
        data: { attempts: { increment: 1 } }
    })

    if (counted.count !== 1) {
        return false
    }

    const expected = Buffer.from(otp.codeHash, "hex")
    const actual = Buffer.from(hashCode(userId, purpose, code.trim()), "hex")

    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return false
    }

    const consumed = await prisma.emailOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: now } })
    return consumed.count === 1
}
