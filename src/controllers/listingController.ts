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

    if(isNaN(id)){
        res.status(400).send("Id has to be a number")
        return
    }
    const specificData = await prisma.listing.findUnique({where:{id}})

    if(!specificData){
        res.status(404).send("Listing not found")
        return
    }

    res.send(specificData)
}

export const createListing = async(req: Request, res:Response) =>{
    const {title, description, price, category} = req.body

    if(!title || !description || !price || !category){
        res.status(400).send("All areas must be filled")
        return
    }

    if(isNaN(Number(price))){
        res.status(400).send("Price has to be a number")
        return
    }

    try{
        const newListing = await prisma.listing.create({data:{
            title,
            description,
            price: Number(price),
            category
        }})
        res.send (newListing)
    }catch(error){
        res.status(500).send("Sorry there is an issue on our end")
    }

}

export const updateListing = async(req:Request, res:Response) =>{
    const id = Number(req.params.id)
    const updates = req.body



    if(isNaN(id)){
        res.status(400).send("Id has to be a number")
        return
    }

    if (updates.price !== undefined) {
        if (isNaN(Number(updates.price))) {
            res.status(400).send("Price has to be a number");
            return;
        }
        if (Number(updates.price) === 0) {
            res.status(400).send("Price cannot be 0");
            return;
        }
        updates.price = Number(updates.price)
    }

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

     if(isNaN(id)){
        res.status(400).send("Id has to be a number")
        return
    }

    try{
        await prisma.listing.delete({where: {id}})
        res.send("Listing deleted successfully")
    }catch(error){
        res.status(404).send("Listing not found")
    }
}