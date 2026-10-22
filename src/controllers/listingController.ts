import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma } from "../generated/prisma/client.js"
import { categories, getCanonicalCategory } from "../lib/categories.js"
import { heldReservationConditions } from "../lib/inventoryReservations.js"
import { imagesInclude, readListingImages, withImages } from "../lib/listingImages.js"
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





export const listingsPageSize = 24

// The public listings, newest first, a page at a time (?page=, 24 per page), optionally narrowed by ?category= and ?search=.
export const getAllListings = async (req:Request, res:Response) =>{
    const {category, search} = req.query
    const pageValue = req.query.page === undefined ? 1 : Number(req.query.page)

    if (typeof req.query.page === "string" && !(Number.isSafeInteger(pageValue) && pageValue >= 1)) {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    if (req.query.page !== undefined && typeof req.query.page !== "string") {
        res.status(400).send({ message: "Page must be a positive whole number" })
        return
    }

    const page = pageValue
    // Listings the seller took off sale are not shown to shoppers.
    const filters:Prisma.ListingWhereInput /* a type that prisma created to fit this variable properly  it can be gotten from the erro description if it shows an error*/= { archivedAt: null }

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

    const [total, listings] = await Promise.all([prisma.listing.count({ where: filters }), prisma.listing.findMany({
        where:filters,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * listingsPageSize,
        take: listingsPageSize,
        include:{
            images: imagesInclude,
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
    })])

    const listingsWithShop = listings.map((listing) => {
        const {user, ...rest} = withImages(listing)
        return {
            ...rest,
            sellerSlug: user.sellerProfile?.slug ?? null,
            sellerName: user.sellerProfile?.businessName ?? null
        }
    })

    res.send({ page, pageSize: listingsPageSize, total, listings: listingsWithShop })
}






export const getListingById  = async (req:Request, res:Response) =>{
    const id = Number(req.params.id)

    if(!Number.isSafeInteger(id)){
        res.status(400).send({message:"Id has to be a number"})
        return
    }
    const specificData = await prisma.listing.findUnique({
        where:{id},
        include:{
            images: imagesInclude,
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
    if(!specificData || specificData.archivedAt){
        res.status(404).send({message:"Listing not found"})
        return
    }

    // The same shape as the list, so a product page can name the seller and link to the shop.
    // The seller's account id is not part of it.
    const {user, userId: _sellerAccountId, ...listing} = withImages(specificData)
    res.send({
        ...listing,
        sellerSlug: user.sellerProfile?.slug ?? null,
        sellerName: user.sellerProfile?.businessName ?? null
    })
}






export const createListing = async(req: Request, res:Response) =>{
    const {title, description, price, category, imageUrl, stockQuantity} = req.body

    if(!title || !description || !price || !category || (!imageUrl && req.body.imageUrls === undefined) || stockQuantity === undefined){
        res.status(400).send({message:"All areas must be filled"})
        return
    }

    const textProblem = listingTextProblem({ title, description, category })

    if (textProblem) {
        res.status(400).send({message: textProblem})
        return
    }

    const photos = readListingImages(req.body)

    if (photos === undefined || "error" in photos) {
        res.status(400).send({message: photos === undefined ? "Add at least one photo" : photos.error})
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
            imageUrl: photos[0]!,
            stockQuantity,
            images: { create: photos.map((url, position) => ({ url, position })) }
        }, include: { images: imagesInclude }})
        res.status(201).send(withImages(newListing))
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

    const textProblem = listingTextProblem({ title, description, category })

    if (textProblem) {
        res.status(400).send({message: textProblem})
        return
    }

    const photos = readListingImages(req.body)

    if (photos !== undefined && "error" in photos) {
        res.status(400).send({message: photos.error})
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
    if (photos !== undefined) {
        // Replacing the photos replaces them all; the order sent is the order shown.
        data.imageUrl = photos[0]!
        data.images = { deleteMany: {}, create: photos.map((url, position) => ({ url, position })) }
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
                    data,
                    include: { images: imagesInclude }
                })
            }, {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable
            })
            : await prisma.listing.update({
                where: { id },
                data,
                include: { images: imagesInclude }
            })

        res.send(withImages(updatedListing))
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
                    "Cannot delete listing because it is referenced by checkout, order, or reservation history. Archive it instead to take it off sale.",
                code: "LISTING_HAS_HISTORY"
            })
            return
        }

        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}






// The seller's own listings. Archived ones are left out unless asked for: ?archived=only or ?archived=all.
export const getMyListings = async(req:Request, res:Response) =>{
    const id = req.user!.id
    const archived = req.query.archived

    if (archived !== undefined && archived !== "only" && archived !== "all") {
        res.status(400).send({message:"Archived must be only or all"})
        return
    }

    try{
        const listings =await prisma.listing.findMany({
            where: {
                userId: id,
                ...(archived === "only" ? { archivedAt: { not: null } } : archived === "all" ? {} : { archivedAt: null })
            },
            include: { images: imagesInclude }
        })
        res.send(listings.map(withImages))
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}

// Takes a listing off sale without deleting it, so its order history stays intact. It disappears from the shop,
// search and discovery, and is removed from shoppers' carts (a cart is not a commitment). Checkouts already in
// progress and paid orders are not touched. Archiving twice is harmless.
export const archiveListing = async(req:Request, res:Response) =>{
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
        res.status(403).send({message:"You are not allowed to archive this listing"})
        return
    }

    try{
        const archived = await prisma.$transaction(async (tx) => {
            await tx.cartItem.deleteMany({ where: { listingId: id } })
            return tx.listing.update({ where: { id }, data: { archivedAt: listing.archivedAt ?? new Date() }, include: { images: imagesInclude } })
        })
        res.send({message:"Listing archived", listing: withImages(archived)})
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}

// Puts an archived listing back on sale.
export const unarchiveListing = async(req:Request, res:Response) =>{
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
        res.status(403).send({message:"You are not allowed to change this listing"})
        return
    }

    try{
        const restored = await prisma.listing.update({ where: { id }, data: { archivedAt: null }, include: { images: imagesInclude } })
        res.send({message:"Listing restored", listing: withImages(restored)})
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}
