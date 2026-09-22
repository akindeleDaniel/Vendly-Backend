import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma } from "../generated/prisma/client.js"

const allowedCategories = ["Food", "Fashion", "Electronics", "Groceries", "Home", "Beauty", "Other"]

function isInvalidPrice(price: unknown){
    const amount = Number(price)
    return isNaN(amount) || amount <= 0
}

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
        res.status(400).send({message:"Id has to be a number"})
        return
    }
    const specificData = await prisma.listing.findUnique({where:{id}})
    if(!specificData){
        res.status(404).send({message:"Listing not found"})
        return
    }

    res.send(specificData)
}

export const createListing = async(req: Request, res:Response) =>{
    const {title, description, price, category, imageUrl} = req.body

    if(!title || !description || !price || !category || !imageUrl){
        res.status(400).send({message:"All areas must be filled"})
        return
    }

    if(isInvalidPrice(price)){
        res.status(400).send({message:"Price must be a number greater than 0"})
        return
    }

    if(!allowedCategories.includes(category)){
        res.status(400).send({message:"Category is not valid"})
        return
    }

    try{
        const newListing = await prisma.listing.create({data:{
            userId: req.user!.id,
            title,
            description,
            price: Number(price),
            category,
            imageUrl
        }})
        res.status(201).send(newListing)
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }

}

export const updateListing = async(req:Request, res:Response) =>{
    const id = Number(req.params.id)
    const {title, description, price, category, imageUrl} = req.body

    if(isNaN(id)){
        res.status(400).send({message:"Id has to be a number"})
        return 
    }
    
    const listing = await prisma.listing.findUnique({ where: { id } })

    if (!listing) {
        res.status(404).send({message:"Listing not found"})
        return
    }

    if (listing.userId !== req.user!.id) {
        res.status(403).send({message:"You are not allowed to edit this listing"})
        return
    }

    if (price !== undefined) {
        if (isInvalidPrice(price)) {
            res.status(400).send({message:"Price must be a number greater than 0"})
            return
        }
    }

    if (category !== undefined && !allowedCategories.includes(category)) {
        res.status(400).send({message:"Category is not valid"})
        return
    }

    if (imageUrl === "" || category === "" || title === "" ||description
        === ""
    ) {
        res.status(400).send({message:"All areas must be filled"})
        return
    }

    const data: Prisma.ListingUpdateInput = {}

    if (title !== undefined) {
        data.title = title
    }
    if (description !== undefined) {
        data.description = description
    }
    if (price !== undefined) {
        data.price = Number(price)
    }
    if (category !== undefined) {
        data.category = category
    }
    if (imageUrl !== undefined) {
        data.imageUrl = imageUrl
    }

    if (Object.keys(data).length === 0) {
        res.status(400).send({message:"Provide at least one field to update"})
        return
    }

    try{
        const updatedListing = await prisma.listing.update({
            where:{id},
            data
        })//whenever you use prisma.anything it returns the value 
        res.send(updatedListing)
    }catch (error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}

export const deleteListing = async(req:Request, res:Response) =>{
    const id = Number(req.params.id)

     if(isNaN(id)){
        res.status(400).send({message:"Id has to be a number"})
        return
    }

    const listing = await prisma.listing.findUnique({ where: { id } })

    if (!listing) {
        res.status(404).send({message:"Listing not found"})
        return
    }

    if (listing.userId !== req.user!.id) {
        res.status(403).send({message:"You are not allowed to delete this listing"})
        return
    }


    try{
        await prisma.listing.delete({where: {id}})
        res.send({message:"Listing deleted successfully"})
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}

export const getMyListings = async(req:Request, res:Response) =>{
    const id = req.user!.id

    try{
        const listings =await prisma.listing.findMany({
            where: {userId: id}
        })
        res.send(listings)
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}