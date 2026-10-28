import type { NextFunction, Request, Response } from "express"
import prisma from "../lib/prisma.js"

// Administrators judge complaints, refunds and sellers, so their accounts never shop or sell.
const adminRefusal = { message: "Administrator accounts can't shop or sell. Use a separate account for that", code: "ADMIN_ACCOUNT" }

export function requireRole(role: "CONSUMER" | "SELLER") {
    return async (req: Request, res: Response, next: NextFunction) => {
        try{
            const user = await prisma.user.findUnique({where:{id: req.user!.id}})

            if(user?.isAdmin){
                res.status(403).send(adminRefusal)
                return
            }

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

// Buying: any account can shop, sellers included (they are kept away from their own shop where it matters).
export async function requireBuyer(req: Request, res: Response, next: NextFunction) {
    try{
        const user = await prisma.user.findUnique({where:{id: req.user!.id}, select: {role: true, isAdmin: true}})

        if(user?.isAdmin){
            res.status(403).send(adminRefusal)
            return
        }

        if(!user || (user.role !== "CONSUMER" && user.role !== "SELLER")){
            res.status(403).send({message: "Only shoppers can do this"})
            return
        }

        next()
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}
