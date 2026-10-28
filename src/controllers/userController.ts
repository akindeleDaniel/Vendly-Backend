import bcrypt from "bcrypt"
import prisma from "../lib/prisma.js"
import type { Request, Response } from "express"
import { Prisma } from "../generated/prisma/client.js"
import { clearSessionCookies, endAllSessions, endSession, refreshSession, startSession } from "../lib/sessions.js"
import { isRegistrationRole, normaliseEmail, validateName, validatePassword } from "../lib/accountRules.js"
import { sendEmail } from "../lib/email/index.js"
import { accountExistsEmail } from "../lib/email/templates.js"
import { issueOtp } from "../lib/otp.js"
import { isTrustedDevice } from "../lib/trustedDevices.js"

// Compared against when an email is unknown, so a wrong email takes as long to refuse as a wrong
// password and the response time does not reveal which emails are registered.
const timingEqualiserHash = bcrypt.hashSync("timing-equaliser", 10)


export const createUser = async (req: Request, res: Response) => {
    const { name: rawName, email: rawEmail, password, role } = req.body;

    if (!rawName || !rawEmail || !password || !role) {
        res.status(400).send({ message: "All areas are required" });
        return;
    }

    const nameProblem = validateName(rawName);

    if (nameProblem) {
        res.status(400).send({ message: nameProblem });
        return;
    }

    const email = normaliseEmail(rawEmail);

    if (!email) {
        res.status(400).send({ message: "Enter a valid email address" });
        return;
    }

    // Only these two roles can be chosen at registration; administrators are made by a script.
    if (!isRegistrationRole(role)) {
        res.status(400).send({ message: "Role must be CONSUMER or SELLER" });
        return;
    }

    const name = (rawName as string).trim();
    const passwordProblem = validatePassword(password, { email, name });

    if (passwordProblem) {
        res.status(400).send({ message: passwordProblem });
        return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const existing = await prisma.user.findUnique({ where: { email } });

    // The answer is the same for every address, so sign-up cannot be used to find out who is registered.
    const checkYourEmail = {
        message: "Check your email for a code to finish creating your account",
        email
    };

    try {
        if (existing?.emailVerifiedAt) {
            // The person who owns the account is told, by email, that someone tried to register with their address.
            await sendEmail(accountExistsEmail(email)).catch((error) => {
                console.error("Could not send the account-exists notice", { reason: error instanceof Error ? error.message : undefined });
            });
            res.send(checkYourEmail);
            return;
        }

        // A sign-up that was never confirmed is simply started again with the new details, so nobody can
        // block an address by registering it without confirming. It has no logins to protect.
        const user = await prisma.$transaction(async (tx) => {
            const saved = existing
                ? await tx.user.update({ where: { id: existing.id }, data: { name, passwordHash, role } })
                : await tx.user.create({ data: { name, email, passwordHash, role } });

            if (role === "CONSUMER") {
                await tx.cart.upsert({ where: { userId: saved.id }, create: { userId: saved.id }, update: {} });
            } else {
                await tx.cart.deleteMany({ where: { userId: saved.id } });
            }

            return saved;
        });

        try {
            if (existing) {
                // Starting over: a code sent for the earlier details must not confirm the new ones.
                await prisma.emailOtp.updateMany({ where: { userId: user.id, purpose: "VERIFY_EMAIL", consumedAt: null }, data: { consumedAt: new Date() } });
            }

            await issueOtp(user, "VERIFY_EMAIL");
        } catch (error) {
            console.error("Could not send a code", { userId: user.id, purpose: "VERIFY_EMAIL", reason: error instanceof Error ? error.message : undefined });
        }

        res.send(checkYourEmail);

    } catch (error) {
        // Two sign-ups with the same email at the same moment: the database lets only one create the account.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            res.send(checkYourEmail);
            return;
        }

        console.error(error);
        res.status(500).send({
            message: "Sorry there is an issue on our end"
        });
    }
};

export const loginUser = async(req: Request, res: Response) =>{
    const {email: rawEmail, password} = req.body

    if(!rawEmail || !password){
        res.status(400).send({message:"All areas are required"})
        return
    }

    const email = normaliseEmail(rawEmail)
    // A password that is not text, or longer than any allowed password, cannot be right.
    const passwordIsPlausible = typeof password === "string" && Buffer.byteLength(password, "utf8") <= 1024
    const existingUser = email ? await prisma.user.findUnique({where:{email}}) : null

    // Always do one password comparison, so unknown emails and wrong passwords take the same time.
    const passwordMatches = await bcrypt.compare(
        passwordIsPlausible ? password : "not-a-password",
        existingUser?.passwordHash ?? timingEqualiserHash
    )

    if(!existingUser || !passwordIsPlausible || !passwordMatches){
        res.status(400).send({message:"Invalid email or password"})
        return
    }
    
    // An account that never confirmed its email cannot log in. The password was right, so it is safe to say why.
    if (!existingUser.emailVerifiedAt) {
        try {
            await issueOtp(existingUser, "VERIFY_EMAIL")
        } catch (error) {
            console.error("Could not send a code", { userId: existingUser.id, purpose: "VERIFY_EMAIL", reason: error instanceof Error ? error.message : undefined })
        }

        res.status(403).send({
            code: "EMAIL_NOT_VERIFIED",
            message: "Confirm your email to continue. We have sent you a code.",
            email: existingUser.email
        })
        return
    }

    // A browser that entered a code in the last 30 days goes straight in; administrators always enter a code.
    if (!existingUser.isAdmin && await isTrustedDevice(req, existingUser.id)) {
        await startSession(req, res, existingUser.id)
        res.send({
            message: "Login Successful",
            role: existingUser.role
        })
        return
    }

    try {
        await issueOtp(existingUser, "LOGIN")
    } catch (error) {
        console.error("Could not send a code", { userId: existingUser.id, purpose: "LOGIN", reason: error instanceof Error ? error.message : undefined })
    }

    res.send({
        otpRequired: true,
        message: "Enter the code we emailed you to log in on this device.",
        email: existingUser.email
    })
}

export const logout = async (req: Request, res: Response) => {
    try {
        await endSession(req)
    } catch (error) {
        console.error(error)
    }

    clearSessionCookies(res)
    res.send({ message: "Logged out successfully" })
}

// Ends every login of this account, on every device.
export const logoutEverywhere = async (req: Request, res: Response) => {
    await endAllSessions(req.user!.id)
    clearSessionCookies(res)
    res.send({ message: "Logged out on every device" })
}

// Called by the frontend when the access token has expired. Swaps the refresh token for a new pair.
export const refresh = async (req: Request, res: Response) => {
    const userId = await refreshSession(req, res)

    if (userId === null) {
        clearSessionCookies(res)
        res.status(401).send({ message: "Your session has ended. Please log in again." })
        return
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isAdmin: true, isSuperAdmin: true } })

    if (!user) {
        clearSessionCookies(res)
        res.status(401).send({ message: "Your session has ended. Please log in again." })
        return
    }

    res.send({ message: "Session refreshed", role: user.role, isAdmin: user.isAdmin, isSuperAdmin: user.isSuperAdmin })
}

// Turns a buyer's account into a seller's, so they can open a shop without a second account. Their orders, cart and
// history stay as they are, and they can still shop. There is no way back to a buyer-only account.
export const becomeSeller = async (req: Request, res: Response) => {
    const userId = req.user!.id

    try {
        const account = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } })

        if (account?.isAdmin) {
            res.status(403).send({ message: "Administrator accounts can't shop or sell. Use a separate account for that", code: "ADMIN_ACCOUNT" })
            return
        }

        await prisma.user.updateMany({ where: { id: userId, role: "CONSUMER" }, data: { role: "SELLER" } })
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })

        if (!user) {
            res.status(401).send({ message: "You're logged out" })
            return
        }

        res.send({ message: "You can now set up your shop", role: user.role })
    } catch (error) {
        console.error(error)
        res.status(500).send({ message: "Sorry there is an issue on our end" })
    }
}

// Email settings a signed-in person can change. Only cart reminders for now.
export const updateEmailPreferences = async (req: Request, res: Response) => {
    const { cartReminders } = req.body

    if (typeof cartReminders !== "boolean") {
        res.status(400).send({ message: "cartReminders must be true or false" })
        return
    }

    const user = await prisma.user.update({ where: { id: req.user!.id }, data: { cartRemindersOff: !cartReminders }, select: { cartRemindersOff: true } })
    res.send({ cartReminders: !user.cartRemindersOff })
}

export const checkAuth = async (req: Request, res: Response) => {
    const userId = req.user?.id;

    if (!userId) {
        res.status(401).send({
            message: "You're logged out"
        });
        return;
    }

    try {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                name: true,
                role: true,
                isAdmin: true,
                isSuperAdmin: true,
                passwordHash: true,
                cartRemindersOff: true
            }
        });

        if (!user) {
            res.status(401).send({
                message: "You're logged out"
            });
            return;
        }

        res.send({
            message: "Authenticated",
            name: user.name,
            role: user.role,
            // Lets the frontend show the administrator screens. The server still checks it on every admin request.
            isAdmin: user.isAdmin,
            // Lets the frontend show the team, audit log and platform screens (super administrators only).
            isSuperAdmin: user.isSuperAdmin,
            // False for an account created with Google that has not set a password yet.
            hasPassword: user.passwordHash !== null,
            // Whether they get one "you left something in your cart" email after leaving items there for a day.
            cartReminders: !user.cartRemindersOff
        });

    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: "Sorry there is an issue on our end"
        });
    }
};
