import type { NextFunction, Request, Response } from "express"
import prisma from "../lib/prisma.js"

// Only super administrators may continue. Like requireAdmin, the flags are read from the database on every request,
// so removing someone takes effect at once.
export async function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { isAdmin: true, isSuperAdmin: true } })

        if (!user?.isAdmin || !user.isSuperAdmin) {
            res.status(403).send({ message: "Only super administrators can do this" })
            return
        }

        next()
    } catch (error) {
        res.status(500).send({ message: "Sorry there is an issue on our end" })
    }
}
