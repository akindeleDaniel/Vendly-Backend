import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import shuffleArray from "../lib/shuffle.js"
import { Prisma } from "../generated/prisma/client.js"
import { categories, getCanonicalCategory } from "../lib/categories.js"
import { heldReservationConditions } from "../lib/inventoryReservations.js"
import {
    isHttpsUrl,
    maximumListingDescriptionLength,
    maximumListingTitleLength,
    maximumStockQuantity,
    priceProblem
} from "../lib/inputRules.js"

class ReservedStockConflict extends Error {
    constructor(readonly reservedQuantity: number) {
        super("Requested stock is below the quantity currently reserved")
    }
}

// The text fields that were given must be text of a sensible size, and the image must be an https link.
function listingTextProblem(fields: { title?: unknown; description?: unknown; category?: unknown; imageUrl?: unknown }): string | null {
    const { title, description, category, imageUrl } = fields

    for (const [name, value] of [["Title", title], ["Description", description], ["Category", category], ["Image URL", imageUrl]] as const) {
        if (value !== undefined && typeof value !== "string") {
            return `${name} must be text`
        }
    }

    if (typeof title === "string" && title.trim().length > maximumListingTitleLength) {
        return `Title must be ${maximumListingTitleLength} characters or fewer`
    }

    if (typeof description === "string" && description.trim().length > maximumListingDescriptionLength) {
        return `Description must be ${maximumListingDescriptionLength} characters or fewer`
    }

    if (imageUrl !== undefined && !isHttpsUrl(imageUrl)) {
        return "Image URL must be an https link"
    }

    return null
}

function stockProblem(stockQuantity: unknown): string | null {
    if (!Number.isInteger(stockQuantity) || (stockQuantity as number) < 0) {
        return "Stock quantity must be a whole number greater than or equal to 0"
    }

    if ((stockQuantity as number) > maximumStockQuantity) {
        return `Stock quantity cannot be more than ${maximumStockQuantity.toLocaleString("en-NG")}`
    }

    return null
}





export const getAllListings = async (req:Request, res:Response) =>{
    const {category, search} = req.query
    const filters:Prisma.ListingWhereInput /* a type that prisma created to fit this variable properly  it can be gotten from the erro description if it shows an error*/= {}

    if (category !== undefined) {
        const canonicalCategory = getCanonicalCategory(category)

        if (!canonicalCategory) {
            res.status(400).send({ message: "Category is not valid" })
            return
        }

        filters.category = { equals: canonicalCategory, mode: "insensitive" }
    }

    if (search !== undefined && typeof search !== "string") {
        res.status(400).send({ message: "Search must be a string" })
        return
    }

    const searchTerm = typeof search === "string" ? search.trim() : ""
    if (searchTerm) {
        filters.title = { contains: searchTerm, mode: "insensitive" }
    }

    const listings =await prisma.listing.findMany({
        where:filters,
        include:{
            user:{
                select:{
                    sellerProfile:{
                        select:{
                            slug:true,
                            businessName:true
                        }
                    }
                }
            }
        }
    })

    const listingsWithShop = listings.map((listing) => {
        const {user, ...rest} = listing
        return {
            ...rest,
            sellerSlug: user.sellerProfile?.slug ?? null,
            sellerName: user.sellerProfile?.businessName ?? null
        }
    })

    res.send(shuffleArray(listingsWithShop))
}






export const getListingById  = async (req:Request, res:Response) =>{
    const id = Number(req.params.id)

    if(!Number.isSafeInteger(id)){
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
    const {title, description, price, category, imageUrl, stockQuantity} = req.body

    if(!title || !description || !price || !category || !imageUrl || stockQuantity === undefined){
        res.status(400).send({message:"All areas must be filled"})
        return
    }

    const textProblem = listingTextProblem({ title, description, category, imageUrl })

    if (textProblem) {
        res.status(400).send({message: textProblem})
        return
    }

    const priceError = priceProblem(price)

    if(priceError){
        res.status(400).send({message: priceError})
        return
    }

    if(!categories.includes(category)){
        res.status(400).send({message:"Category is not valid"})
        return
    }

    const stockError = stockProblem(stockQuantity)

    if (stockError) {
        res.status(400).send({ message: stockError });
        return;
    }

    try{
        const sellerProfile = await prisma.sellerProfile.findUnique({where:{userId: req.user!.id}})
    
        if(!sellerProfile){
            res.status(400).send({message:"Set up your store before creating a listing"})
            return
        }

        const newListing = await prisma.listing.create({data:{
            userId: req.user!.id,
            title,
            description,
            price: Number(price),
            category,
            imageUrl,
            stockQuantity
        }})
        res.status(201).send(newListing)
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }

}




export const updateListing = async(req:Request, res:Response) =>{
    const id = Number(req.params.id)
    const {title, description, price, category, imageUrl, stockQuantity} = req.body

    if(!Number.isSafeInteger(id)){
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

    const textProblem = listingTextProblem({ title, description, category, imageUrl })

    if (textProblem) {
        res.status(400).send({message: textProblem})
        return
    }

    if (price !== undefined) {
        const priceError = priceProblem(price)

        if (priceError) {
            res.status(400).send({message: priceError})
            return
        }
    }

    if (stockQuantity !== undefined) {
        const stockError = stockProblem(stockQuantity)

        if (stockError) {
            res.status(400).send({ message: stockError });
            return;
        }
    }

    if (category !== undefined && !categories.includes(category)) {
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
    if (stockQuantity !== undefined) {
        data.stockQuantity = stockQuantity
    }

    if (Object.keys(data).length === 0) {
        res.status(400).send({message:"Provide at least one field to update"})
        return
    }

    try{
        const updatedListing = stockQuantity !== undefined
            ? await prisma.$transaction(async (tx) => {
                const now = new Date()
                const reservations = await tx.inventoryReservation.aggregate({
                    where: {
                        listingId: id,
                        OR: heldReservationConditions(now)
                    },
                    _sum: {
                        quantity: true
                    }
                })
                const reservedQuantity = reservations._sum.quantity ?? 0

                if (stockQuantity < reservedQuantity) {
                    throw new ReservedStockConflict(reservedQuantity)
                }

                return tx.listing.update({
                    where: { id },
                    data
                })
            }, {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable
            })
            : await prisma.listing.update({
                where: { id },
                data
            })

        res.send(updatedListing)
    }catch (error){
        if (error instanceof ReservedStockConflict) {
            res.status(409).send({
                message: `Stock quantity cannot be less than ${error.reservedQuantity} units currently reserved`
            })
            return
        }

        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
            res.status(409).send({
                message: "Inventory changed while updating stock. Please try again."
            })
            return
        }

        console.error("updateListing failed unexpectedly", { listingId: id }, error)
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}






export const deleteListing = async(req:Request, res:Response) =>{
    const id = Number(req.params.id)

     if(!Number.isSafeInteger(id)){
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
        // P2003 = foreign key constraint failed (listing still referenced)
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2003"
        ) {
            res.status(409).send({
                message:
                    "Cannot delete listing because it is referenced by checkout, order, or reservation history",
            })
            return
        }

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