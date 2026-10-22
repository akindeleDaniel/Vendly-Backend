import type { Request, Response } from "express"
import { Prisma, type User } from "../generated/prisma/client.js"
import prisma from "../lib/prisma.js"
import { isRegistrationRole } from "../lib/accountRules.js"
import { googleSignInAvailable, verifyGoogleCredential, type GoogleIdentity } from "../lib/google.js"
import { checkOtp, issueOtp } from "../lib/otp.js"
import { startSession } from "../lib/sessions.js"
import { notifyWelcome, queueNotification } from "../lib/notifications.js"

const badCodeMessage = "That code is not right or has expired. Ask for a new one."

// Reads and checks the Google sign-in token from the request. Sends the error answer itself and returns null when it fails.
async function readIdentity(req: Request, res: Response): Promise<GoogleIdentity | null> {
    if (!googleSignInAvailable()) {
        res.status(503).send({ message: "Google sign-in is not available right now" })
        return null
    }

    const { credential } = req.body

    if (typeof credential !== "string" || credential.length === 0 || credential.length > 4096) {
        res.status(400).send({ message: "Google sign-in could not be checked. Try again." })
        return null
    }

    const identity = await verifyGoogleCredential(credential)

    if (!identity) {
        res.status(400).send({ message: "Google sign-in could not be checked. Try again." })
        return null
    }

    return identity
}

// Google has already checked the person (including its own two-step verification), so no code is asked for,
// except from administrators, who enter an emailed code on every login however they sign in.
async function finishLogin(req: Request, res: Response, user: User, extra: Record<string, unknown> = {}) {
    if (user.isAdmin) {
        try {
            await issueOtp(user, "LOGIN")
        } catch (error) {
            console.error("Could not send a code", { userId: user.id, purpose: "LOGIN", reason: error instanceof Error ? error.message : undefined })
        }

        res.send({ otpRequired: true, message: "Enter the code we emailed you to log in.", email: user.email })
        return
    }

    await startSession(req, res, user.id)
    res.send({ message: "Login Successful", role: user.role, ...extra })
}

// "Continue with Google", for logging in and for creating an account.
export const googleSignIn = async (req: Request, res: Response) => {
    const identity = await readIdentity(req, res)

    if (!identity) {
        return
    }

    const linked = await prisma.user.findUnique({ where: { googleId: identity.googleId } })

    if (linked) {
        await finishLogin(req, res, linked)
        return
    }

    const sameEmail = await prisma.user.findUnique({ where: { email: identity.email } })

    if (sameEmail?.googleId) {
        res.status(400).send({ message: "That email is already linked to a different Google account" })
        return
    }

    if (sameEmail && !sameEmail.emailVerifiedAt) {
        // A sign-up that never confirmed its email. Google has now proved the address, so the account becomes
        // this person's; any password typed at the earlier sign-up is thrown away.
        const user = await prisma.$transaction(async (tx) => {
            await tx.emailOtp.updateMany({ where: { userId: sameEmail.id, consumedAt: null }, data: { consumedAt: new Date() } })
            return tx.user.update({
                where: { id: sameEmail.id },
                data: { googleId: identity.googleId, emailVerifiedAt: new Date(), passwordHash: null }
            })
        })
        await finishLogin(req, res, user)
        return
    }

    if (sameEmail) {
        // A confirmed account with a password. It is only linked after the owner proves it with an emailed code,
        // so having a Google account with the same address is not enough to get in.
        try {
            await issueOtp(sameEmail, "GOOGLE_LINK")
        } catch (error) {
            console.error("Could not send a code", { userId: sameEmail.id, purpose: "GOOGLE_LINK", reason: error instanceof Error ? error.message : undefined })
        }

        res.send({
            linkRequired: true,
            message: "You already have a Vendly account with this email. Enter the code we emailed you to link Google to it.",
            email: sameEmail.email
        })
        return
    }

    const { role } = req.body

    if (!isRegistrationRole(role)) {
        // A new person: ask whether they are a shopper or a seller, then send the same token again with the role.
        res.send({ roleRequired: true, message: "Choose whether you are a buyer or a seller.", name: identity.name, email: identity.email })
        return
    }

    try {
        const user = await prisma.$transaction(async (tx) => {
            const created = await tx.user.create({
                data: { name: identity.name, email: identity.email, googleId: identity.googleId, emailVerifiedAt: new Date(), role }
            })

            if (role === "CONSUMER") {
                await tx.cart.create({ data: { userId: created.id } })
            }

            return created
        })
        queueNotification("welcome", () => notifyWelcome(user.id))
        await finishLogin(req, res, user, { isNewAccount: true })
    } catch (error) {
        // Two requests creating the same account at once: the other one won, so this one signs in as it.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            const existing = await prisma.user.findUnique({ where: { googleId: identity.googleId } })

            if (existing) {
                await finishLogin(req, res, existing)
                return
            }
        }

        throw error
    }
}

// Finishes linking Google to an existing account with the code that was emailed, then logs in.
export const googleLink = async (req: Request, res: Response) => {
    const identity = await readIdentity(req, res)

    if (!identity) {
        return
    }

    const user = await prisma.user.findUnique({ where: { email: identity.email } })

    if (!user || !user.emailVerifiedAt || user.googleId || !(await checkOtp(user.id, "GOOGLE_LINK", req.body.code))) {
        res.status(400).send({ message: badCodeMessage })
        return
    }

    try {
        const linked = await prisma.user.update({ where: { id: user.id }, data: { googleId: identity.googleId } })
        await finishLogin(req, res, linked)
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            res.status(400).send({ message: "That Google account is already linked to another Vendly account" })
            return
        }

        throw error
    }
}
