import bcrypt from "bcrypt"
import prisma from "../lib/prisma.js"
import type { Request, Response } from "express"
import { clearSessionCookies, endAllSessions, endSession, refreshSession, startSession } from "../lib/sessions.js"

export const createUser = async (req: Request, res: Response) => {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
        res.status(400).send({ message: "All areas are required" });
        return;
    }

    const emailCheck = await prisma.user.findUnique({
        where: { email }
    });

    if (emailCheck) {
        res.status(400).send({
            message: "The email has already been registered"
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
        console.error(error);
        res.status(500).send({
            message: "Sorry there is an issue on our end"
        });
    }
};

export const loginUser = async(req: Request, res: Response) =>{
    const {email, password} = req.body

    if(!email || !password){
        res.status(400).send({message:"All areas are required"})
        return
    }

    const existingUser = await prisma.user.findUnique({where:{email}})

    if (!existingUser){
        res.status(400).send({message:"Invalid email or password"})
        return
    }

    const passwordMatches = await bcrypt.compare(password, existingUser.passwordHash)

    if(!passwordMatches){
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
