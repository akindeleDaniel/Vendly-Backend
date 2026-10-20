import type { NextFunction, Request, Response } from "express"
import prisma from "../lib/prisma.js"

// Only administrators may continue. The flag is read from the database on every request, and only
// scripts/makeAdmin.ts ever sets it: registration cannot.
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { isAdmin: true } })

        if (!user?.isAdmin) {
            res.status(403).send({ message: "Only administrators can do this" })
            return
        }

        next()
    } catch (error) {
        res.status(500).send({ message: "Sorry there is an issue on our end" })
    }
}
