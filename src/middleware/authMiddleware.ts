import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken"

export function authMiddleware (req: Request, res:Response, next:NextFunction){
    
    const cookieToken = req.cookies.token
    
    if(!cookieToken){
        res.status(401).send("Login first")
        return
    }

    try{

        if (!process.env.JWT_SECRET) {
            throw new Error("JWT_SECRET is not set");
        }

        const decoded = jwt.verify(cookieToken, process.env.JWT_SECRET)

        req.user = decoded as {id: number}
        next()
        
    }catch(error){
        res.status(401).send("Invalid or expired token. Please log in again.")
    }
}