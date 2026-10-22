import bcrypt from "bcrypt"
import type { Request, Response } from "express"
import type { OtpPurpose } from "../generated/prisma/client.js"
import prisma from "../lib/prisma.js"
import { normaliseEmail, validatePassword } from "../lib/accountRules.js"
import { checkOtp, issueOtp } from "../lib/otp.js"
import { endAllSessions, startSession } from "../lib/sessions.js"
import { trustThisDevice } from "../lib/trustedDevices.js"
import { notifyPasswordChanged, notifyWelcome, queueNotification } from "../lib/notifications.js"

const badCodeMessage = "That code is not right or has expired. Ask for a new one."
// Same answer whether or not the address has an account, so these routes cannot be used to find out who is registered.
const neutralCodeMessage = "If that account needs a code, we have emailed one."
// Someone who passed the password step has this long to ask for the login code again.
const loginCodeResendWindowMs = 30 * 60 * 1000

async function findUser(rawEmail: unknown) {
    const email = normaliseEmail(rawEmail)
    return email ? prisma.user.findUnique({ where: { email } }) : null
}

// Sending can fail (the email service is down). The caller gets the same answer either way; the failure is logged.
async function tryIssueOtp(user: { id: number; email: string }, purpose: OtpPurpose) {
    try {
        await issueOtp(user, purpose)
    } catch (error) {
        console.error("Could not send a code", { userId: user.id, purpose, reason: error instanceof Error ? error.message : undefined })
    }
}

// Entering the code from the sign-up email finishes registration, and logs the person in on this device.
export const verifyEmail = async (req: Request, res: Response) => {
    const user = await findUser(req.body.email)

    if (!user || !(await checkOtp(user.id, "VERIFY_EMAIL", req.body.code))) {
        res.status(400).send({ message: badCodeMessage })
        return
    }

    if (!user.emailVerifiedAt) {
        await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } })
        queueNotification("welcome", () => notifyWelcome(user.id))
    }

    await startSession(req, res, user.id)
    await trustThisDevice(req, res, user.id)
    res.send({ message: "Email confirmed", role: user.role })
}

// Entering the code from the login email (asked after a correct password on a device we do not know).
export const verifyLogin = async (req: Request, res: Response) => {
    const user = await findUser(req.body.email)

    if (!user || !user.emailVerifiedAt || !(await checkOtp(user.id, "LOGIN", req.body.code))) {
        res.status(400).send({ message: badCodeMessage })
        return
    }

    await startSession(req, res, user.id)

    // Administrators enter a code every time, so their devices are never remembered.
    if (!user.isAdmin) {
        await trustThisDevice(req, res, user.id)
    }

    res.send({ message: "Login Successful", role: user.role })
}

export const resendCode = async (req: Request, res: Response) => {
    const { purpose } = req.body

    if (purpose !== "VERIFY_EMAIL" && purpose !== "LOGIN") {
        res.status(400).send({ message: "Purpose must be VERIFY_EMAIL or LOGIN" })
        return
    }

    const user = await findUser(req.body.email)

    if (user && purpose === "VERIFY_EMAIL" && !user.emailVerifiedAt) {
        await tryIssueOtp(user, "VERIFY_EMAIL")
    }

    if (user && purpose === "LOGIN" && user.emailVerifiedAt) {
        // Only someone who recently passed the password step has a login code to ask for again.
        const recent = await prisma.emailOtp.findFirst({
            where: { userId: user.id, purpose: "LOGIN", createdAt: { gt: new Date(Date.now() - loginCodeResendWindowMs) } },
            select: { id: true }
        })

        if (recent) {
            await tryIssueOtp(user, "LOGIN")
        }
    }

    res.send({ message: neutralCodeMessage })
}

export const forgotPassword = async (req: Request, res: Response) => {
    const user = await findUser(req.body.email)

    if (user) {
        await tryIssueOtp(user, "PASSWORD_RESET")
    }

    res.send({ message: neutralCodeMessage })
}

// Sets a new password with the emailed code. Every login on every device ends, so the person logs in again with the new password.
export const resetPassword = async (req: Request, res: Response) => {
    const user = await findUser(req.body.email)
    const { newPassword } = req.body

    // Checked first so a weak password does not use up one of the code's five tries.
    const passwordProblem = validatePassword(newPassword, { email: user?.email ?? "", name: user?.name ?? "" })

    if (passwordProblem) {
        res.status(400).send({ message: passwordProblem })
        return
    }

    if (!user || !(await checkOtp(user.id, "PASSWORD_RESET", req.body.code))) {
        res.status(400).send({ message: badCodeMessage })
        return
    }

    await prisma.user.update({
        where: { id: user.id },
        data: {
            passwordHash: await bcrypt.hash(newPassword, 10),
            // Receiving the code proves the email, so a reset also finishes an unconfirmed sign-up.
            emailVerifiedAt: user.emailVerifiedAt ?? new Date()
        }
    })
    await endAllSessions(user.id)
    queueNotification("password reset", () => notifyPasswordChanged(user.id, "reset"))
    res.send({ message: "Your password has been changed. Log in with the new password." })
}

// For a logged-in user who knows their password. Ends every other login and keeps this one.
export const changePassword = async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body

    if (typeof currentPassword !== "string" || currentPassword.length === 0 || typeof newPassword !== "string") {
        res.status(400).send({ message: "All areas are required" })
        return
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })

    if (!user) {
        res.status(401).send({ message: "Your session has ended. Please log in again." })
        return
    }

    if (!user.passwordHash) {
        res.status(400).send({ code: "NO_PASSWORD", message: "Your account has no password yet. Set one first." })
        return
    }

    if (Buffer.byteLength(currentPassword, "utf8") > 1024 || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
        res.status(400).send({ message: "Your current password is not right" })
        return
    }

    const passwordProblem = validatePassword(newPassword, { email: user.email, name: user.name })

    if (passwordProblem) {
        res.status(400).send({ message: passwordProblem })
        return
    }

    if (newPassword === currentPassword) {
        res.status(400).send({ message: "Choose a password different from your current one" })
        return
    }

    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, 10) } })
    await endAllSessions(user.id)
    await startSession(req, res, user.id)
    queueNotification("password changed", () => notifyPasswordChanged(user.id, "changed"))
    res.send({ message: "Your password has been changed." })
}

// For an account created with Google, which has no password: asks for an emailed code first, because a password
// lets anyone who holds it in later bypass Google, so setting one must prove control of the inbox, not only of a session.
export const sendSetPasswordCode = async (req: Request, res: Response) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })

    if (!user) {
        res.status(401).send({ message: "Your session has ended. Please log in again." })
        return
    }

    if (user.passwordHash) {
        res.status(400).send({ code: "HAS_PASSWORD", message: "Your account already has a password. Use change password instead." })
        return
    }

    await tryIssueOtp(user, "SET_PASSWORD")
    res.send({ message: "We have emailed you a code." })
}

export const setPassword = async (req: Request, res: Response) => {
    const { code, newPassword } = req.body
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })

    if (!user) {
        res.status(401).send({ message: "Your session has ended. Please log in again." })
        return
    }

    if (user.passwordHash) {
        res.status(400).send({ code: "HAS_PASSWORD", message: "Your account already has a password. Use change password instead." })
        return
    }

    const passwordProblem = validatePassword(newPassword, { email: user.email, name: user.name })

    if (passwordProblem) {
        res.status(400).send({ message: passwordProblem })
        return
    }

    if (!(await checkOtp(user.id, "SET_PASSWORD", code))) {
        res.status(400).send({ message: badCodeMessage })
        return
    }

    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, 10) } })
    await endAllSessions(user.id)
    await startSession(req, res, user.id)
    queueNotification("password set", () => notifyPasswordChanged(user.id, "set"))
    res.send({ message: "Your password has been set." })
}
