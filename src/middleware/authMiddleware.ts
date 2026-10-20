import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken"
import { isAccessTokenLive } from "../lib/sessions.js"

export async function authMiddleware (req: Request, res:Response, next:NextFunction){

    const cookieToken = req.cookies.token

    if(!cookieToken){
        res.status(401).send({message:"Login first"})
        return
    }

    if (!process.env.JWT_SECRET) {
        throw new Error("JWT_SECRET is not set");
    }

    let decoded: jwt.JwtPayload

    try{
        const verified = jwt.verify(cookieToken, process.env.JWT_SECRET)

        if (typeof verified !== "object" || typeof verified.id !== "number") {
            throw new Error("Unexpected token contents")
        }

        decoded = verified
    }catch(error){
        res.status(401).send({message:"Invalid or expired token. Please log in again."})
        return
    }

    // A signed token is not enough: its login must not have been ended since it was issued.
    // A database failure here is a server error, not a reason to log the user out.
    if (!(await isAccessTokenLive(decoded.id, decoded.sid, decoded.iat))) {
        res.status(401).send({message:"Your session has ended. Please log in again."})
        return
    }

    req.user = {id: decoded.id}
    next()
}
