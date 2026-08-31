import type { Request, Response } from "express";
import prisma from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";


export const getAllListings = async (req:Request, res:Response) =>{
    const {category, search} = req.query
    const filters:Prisma.ListingWhereInput /* a type that prisma created to fit this variable properly  it can be gotten from the erro description if it shows an error*/= {}
    if(category){
        filters.category = {contains: String(category), mode:"insensitive"}
    }

    if (search){
        filters.title = {contains: String(search), mode:"insensitive"}
    }

    const listings =await prisma.listing.findMany({
        where:filters
    })

    res.send(listings)
}

export const getListingById  = async (req:Request, res:Response) =>{
    const id = Number(req.params.id)
    const specificData = await prisma.listing.findUnique({where:{id}})

    if(!specificData){
        res.status(404).send("Listing not found")
    }

    res.send(specificData)
}

export const createListing = async(req: Request, res:Response) =>{
    const {title, description, price, category} = req.body
    const newListing = await prisma.listing.create({data:{
        title,
        description,
        price,
        category
    }})
    res.send (newListing)
}

export const updateListing = async(req:Request, res:Response) =>{
    const id = Number(req.params.id)
    const updates = req.body
    try{
        const updatedListing = await prisma.listing.update({
            where:{id},
            data: updates
        })//whenever you use prisma.anything it returns the value 
        res.send(updatedListing)
    }catch (error){
        res.status(404).send("Listing not found")
    }
}

export const deleteListing = async(req:Request, res:Response) =>{
    const id = Number(req.params.id)
    try{
        await prisma.listing.delete({where: {id}})
        res.send("Listing deleted successfully")
    }catch(error){
        res.status(404).send("Listing not found")
    }
}