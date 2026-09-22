import prisma from "../lib/prisma.js"
import type { Request, Response } from "express"
import { Prisma } from "../generated/prisma/client.js"
import { makeSlug } from "../lib/generateSlug.js"

export const createSeller = async(req: Request, res: Response) => {
    const {businessName, location, logoUrl} = req.body

    if(!businessName || !location || !logoUrl){
        res.status(400).send({message:"All areas are required"})
        return
    }

    let slug = makeSlug(businessName)
    const existingSlug = await prisma.sellerProfile.findUnique({where:{slug}})

    if(existingSlug){
        slug = `${slug}-${req.user!.id}`
    }

    try{
        await prisma.sellerProfile.create({data:{
            userId: req.user!.id,
            businessName,
            location,
            logoUrl,
            slug
        }})
        res.status(201).send({message:"Seller profile created"})
    }catch(error){
        if(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"){
            res.status(400).send({message: "You already have a seller profile"})
            return
        }

        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}

export const getMySellerProfile = async (req: Request, res: Response) => {
    try{
        const profile = await prisma.sellerProfile.findUnique({where:{userId: req.user!.id}})

        if(!profile){
            res.status(404).send({message:"Store profile not found"})
            return
        }

        res.send(profile)
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}

export const updateSeller = async(req: Request, res: Response) => {
    const {businessName, location, logoUrl} = req.body

    if(businessName === undefined && location === undefined && logoUrl === undefined){
        res.status(400).send({message:"Provide at least one field to update"})
        return
    }

    if(businessName === "" || location === "" || logoUrl === ""){
        res.status(400).send({message:"Fields cannot be empty"})
        return
    }

    try{
        const updatedProfile = await prisma.sellerProfile.update({
            where:{userId: req.user!.id},
            data:{businessName, location, logoUrl}
        })
        res.send(updatedProfile)
    }catch(error){
        if(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025"){
            res.status(404).send({message:"Store profile not found"})
            return
        }

        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}