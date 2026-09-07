import bcrypt from "bcrypt"
import prisma from "../lib/prisma.js"
import type { Request, Response } from "express"
import jwt from "jsonwebtoken"

export const createUser = async(req: Request, res: Response) => {
    const {name, email, password} = req.body

    if(!name || !email || !password){
        res.status(400).send("All areas are required")
        return
    }

    const emailCheck = await prisma.user.findUnique({where:{email}})

    if (emailCheck){
        res.status(400).send("The email has already been registered")
        return
    }

    const passwordHash = await bcrypt.hash(password, 10)

    try{
        const newUser = await prisma.user.create({data:{
            name,
            email,
            passwordHash
        }})
        res.send("Registration successful")
    }catch(error){
        res.status(500).send("Sorry there is an issue on our end")
    }
}


export const loginUser = async(req: Request, res: Response) =>{
    const {email, password} = req.body

    if(!email || !password){
        res.status(400).send("All areas are required")
        return
    }

    const existingUser = await prisma.user.findUnique({where:{email}})

    if (!existingUser){
        res.status(400).send("Invalid email or password")
        return
    }

    const passwordMatches = await bcrypt.compare(password, existingUser.passwordHash)

    if(!passwordMatches){
        res.status(400).send("Invalid email or password")
        return
    }
    
    if (!process.env.JWT_SECRET) {
        throw new Error("JWT_SECRET is not set");
    }
    const token = jwt.sign({id: existingUser.id}, process.env.JWT_SECRET, {expiresIn:"1h"})

    
    res.send({message: "Login Successful", token})
}