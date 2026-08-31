import type { Request, Response } from "express";
import prisma from "../lib/prisma.js";
import { stringify } from "node:querystring";
import { title } from "node:process";

export const getAllListings = async (req:Request, res:Response) =>{
    const listings = await prisma.listing.findMany()
    res.send(listings)
}

export const getListingById  = (req:Request, res:Response) =>{
    const id = req.params.id
    res.send(`This will return listing number ${id}`)
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

export const updateListing = (req:Request, res:Response) =>{
    const id = req.params.id
    const updates = req.body
    res.send(`Listing ${id} would be updated with: ${JSON.stringify(updates)}`)
}

export const deleteListing = (req:Request, res:Response) =>{
    const id = req.params.id
    res.send(`Listing ${id} has been deleted`)
}