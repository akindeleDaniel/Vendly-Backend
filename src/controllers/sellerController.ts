import prisma from "../lib/prisma.js"
import type { Request, Response } from "express"
import { Prisma } from "../generated/prisma/client.js"
import { makeSlug } from "../lib/generateSlug.js"
import { buildLocation } from "../lib/nigeriaLocation.js"

export const createSeller = async(req: Request, res: Response) => {
    const {businessName, state, lga, logoUrl} = req.body

    if(!businessName || !logoUrl || !state || !lga){
        res.status(400).send({message:"All areas are required"})
        return
    }
    
    const location = buildLocation(state, lga)

    if (!location) {
        res.status(400).send({ message: "Invalid state or LGA" })
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
            state,
            lga,
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
    const {businessName, state, lga, logoUrl} = req.body

    if(businessName === undefined && state === undefined && logoUrl === undefined && lga === undefined){
        res.status(400).send({message:"Provide at least one field to update"})
        return
    }

    if(businessName === "" || state === "" || logoUrl === "" || lga === ""){
        res.status(400).send({message:"Fields cannot be empty"})
        return
    }

    const location = buildLocation(state, lga)

    if (!location) {
        res.status(400).send({ message: "Invalid state or LGA" })
        return
    }

    try{
        const existingProfile = await prisma.sellerProfile.findUnique({
            where:{userId: req.user!.id}
        })

        if(!existingProfile){
            res.status(404).send({ message: "Store profile not found" })
            return
        }

        const newState = state ?? existingProfile.state
        const newLga = lga ?? existingProfile.lga

        const location = buildLocation(newState, newLga)

        if (!location) {
            res.status(400).send({ message: "Invalid state or LGA" })
            return
        }

        const updatedProfile = await prisma.sellerProfile.update({
            where:{userId: req.user!.id},
            data:{businessName, state, lga, logoUrl, location}
        })

        res.send(updatedProfile)
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}

export const getPublicShop = async (req: Request, res: Response) => {
    const slug = String(req.params.slug)

    try{
        const profile = await prisma.sellerProfile.findUnique({where:{slug}})

        if(!profile){
            res.status(404).send({message:"Store not found"})
            return
        }

        const listings = await prisma.listing.findMany({
            where:{userId: profile.userId}
        })

        res.send({
            profile,
            listings
        })
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}