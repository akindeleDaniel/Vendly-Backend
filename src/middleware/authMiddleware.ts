import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken"

export function authMiddleware (req: Request, res:Response, next:NextFunction){
    
    const authHeader = req.headers.authorization
    if(!authHeader){
        res.status(401).send("Login first")
        return
    }

    
    const token = authHeader.split(" ")[1]

    if(!token){
        res.status(400).send("Error occured")
        return
    }

    try{

        if (!process.env.JWT_SECRET) {
            throw new Error("JWT_SECRET is not set");
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET)

        req.user = decoded as {id: number}
        next()
        
    }catch(error){
        res.status(401).send("Invalid or expired token. Please log in again.")
    }
}