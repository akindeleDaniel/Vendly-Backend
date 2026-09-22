import type { NextFunction, Request, Response } from "express"
import prisma from "../lib/prisma.js"

export function requireRole(role: "CONSUMER" | "SELLER") {
    return async (req: Request, res: Response, next: NextFunction) => {
        try{
            const user = await prisma.user.findUnique({where:{id: req.user!.id}})

            if(!user || user.role !== role){
                res.status(403).send({message: role === "SELLER" ? "Only sellers can do this" : "Only consumers can do this"})
                return
            }

            next()
        }catch(error){
            res.status(500).send({message:"Sorry there is an issue on our end"})
        }
    }
}