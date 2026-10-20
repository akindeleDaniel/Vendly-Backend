import bcrypt from "bcrypt"
import prisma from "../lib/prisma.js"
import type { Request, Response } from "express"
import { Prisma } from "../generated/prisma/client.js"
import { clearSessionCookies, endAllSessions, endSession, refreshSession, startSession } from "../lib/sessions.js"
import { isRegistrationRole, normaliseEmail, validateName, validatePassword } from "../lib/accountRules.js"

// Compared against when an email is unknown, so a wrong email takes as long to refuse as a wrong
// password and the response time does not reveal which emails are registered.
const timingEqualiserHash = bcrypt.hashSync("timing-equaliser", 10)

const emailTakenMessage = "The email has already been registered"

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

    const emailCheck = await prisma.user.findUnique({
        where: { email }
    });

    if (emailCheck) {
        res.status(400).send({
            message: emailTakenMessage
        });
        return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    try {
        const newUser = await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
                data: {
                    name,
                    email,
                    passwordHash,
                    role
                }
            });

            if (role === "CONSUMER") {
                await tx.cart.create({
                    data: {
                        userId: user.id
                    }
                });
            }

            return user;
        });

        await startSession(req, res, newUser.id);

        res.send({ message: "Registration successful" });

    } catch (error) {
        // Two sign-ups with the same email at the same moment: the database lets only one through.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            res.status(400).send({ message: emailTakenMessage });
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
    
    await startSession(req, res, existingUser.id)
    res.send({
        message: "Login Successful",
        role: existingUser.role
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

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isAdmin: true } })

    if (!user) {
        clearSessionCookies(res)
        res.status(401).send({ message: "Your session has ended. Please log in again." })
        return
    }

    res.send({ message: "Session refreshed", role: user.role, isAdmin: user.isAdmin })
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
                role: true,
                isAdmin: true
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
            role: user.role,
            // Lets the frontend show the administrator screens. The server still checks it on every admin request.
            isAdmin: user.isAdmin
        });

    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: "Sorry there is an issue on our end"
        });
    }
};
