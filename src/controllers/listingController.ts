import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma } from "../generated/prisma/client.js"
import { categories, getCanonicalCategory } from "../lib/categories.js"
import { heldReservationConditions } from "../lib/inventoryReservations.js"
import { imagesInclude, readListingImages, withImages } from "../lib/listingImages.js"
import { countChoices, loadChoices, optionTree, propagateToOptions, readOptions, ReservedStockConflict, syncListingOptions, withOptionSummary } from "../lib/listingOptions.js"
import {
    isHttpsUrl,
    maximumListingDescriptionLength,
    maximumListingTitleLength,
    maximumStockQuantity,
    priceProblem
} from "../lib/inputRules.js"

const ownedByOptionsMessage = "This is one choice of a product. Change its title, description, category and photos on the product, and its price and stock here or with PUT /listings/:id/options on the product"

// A listing as the API returns it, with its photos, its rating and its options. A product with options shows its lowest
// price and its total stock; the options themselves (with the listingId to put in the cart) are in `options`.
async function detailedListing<T extends { id: number; imageUrl: string; images: Array<{ url: string }>; ratingSum: number; ratingCount: number; price: number; stockQuantity: number }>(listing: T) {
    const choices = (await loadChoices([listing.id])).get(listing.id)
    return { ...withOptionSummary(withImages(listing), choices), options: optionTree(choices) }
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
    const filters:Prisma.ListingWhereInput /* a type that prisma created to fit this variable properly  it can be gotten from the erro description if it shows an error*/= {
        archivedAt: null,
        // The choices of a product are listings of their own, but shoppers only see the product.
        parentId: null,
        // A blocked shop is hidden from shoppers.
        user: { sellerProfile: { is: { blockedAt: null } } }
    }

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

    const choices = await loadChoices(listings.map((listing) => listing.id))
    const listingsWithShop = listings.map((listing) => {
        const {user, ...rest} = withOptionSummary(withImages(listing), choices.get(listing.id))
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
    const productPageInclude = {
        images: imagesInclude,
        user:{
            select:{
                sellerProfile:{
                    select:{
                        slug:true,
                        businessName:true,
                        blockedAt:true
                    }
                }
            }
        }
    } as const
    const found = await prisma.listing.findUnique({ where:{id}, include: productPageInclude })
    // One choice of a product opens the product, with that choice marked.
    const specificData = found?.parentId
        ? await prisma.listing.findUnique({ where:{id: found.parentId}, include: productPageInclude })
        : found
    if(!specificData || specificData.archivedAt || specificData.user.sellerProfile?.blockedAt){
        res.status(404).send({message:"Listing not found"})
        return
    }

    // The same shape as the list, so a product page can name the seller and link to the shop.
    // The seller's account id is not part of it.
    const {user, userId: _sellerAccountId, ...listing} = await detailedListing(specificData)
    res.send({
        ...listing,
        selectedListingId: found?.parentId ? found.id : null,
        sellerSlug: user.sellerProfile?.slug ?? null,
        sellerName: user.sellerProfile?.businessName ?? null
    })
}






export const createListing = async(req: Request, res:Response) =>{
    const {title, description, price, category, imageUrl, stockQuantity} = req.body
    // A product with options is stocked on its options, so it needs no stock of its own.
    const withOptions = req.body.options !== undefined && req.body.options !== null && !(Array.isArray(req.body.options) && req.body.options.length === 0)

    if(!title || !description || !price || !category || (!imageUrl && req.body.imageUrls === undefined) || (stockQuantity === undefined && !withOptions)){
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

    const stockError = withOptions && stockQuantity === undefined ? null : stockProblem(stockQuantity)

    if (stockError) {
        res.status(400).send({ message: stockError });
        return;
    }

    const options = req.body.options === undefined || req.body.options === null ? [] : readOptions(req.body.options, Number(price))

    if ("error" in options) {
        res.status(400).send({ message: options.error })
        return
    }

    try{
        const sellerProfile = await prisma.sellerProfile.findUnique({where:{userId: req.user!.id}})
    
        if(!sellerProfile){
            res.status(400).send({message:"Set up your store before creating a listing"})
            return
        }

        const newListing = await prisma.$transaction(async (tx) => {
            const created = await tx.listing.create({data:{
                userId: req.user!.id,
                title,
                description,
                price: Number(price),
                category,
                imageUrl: photos[0]!,
                stockQuantity: options.length > 0 ? 0 : stockQuantity,
                images: { create: photos.map((url, position) => ({ url, position })) }
            }, include: { images: imagesInclude }})

            if (options.length > 0) {
                await syncListingOptions(tx, created, options)
            }

            return created
        })
        res.status(201).send(await detailedListing(await prisma.listing.findUniqueOrThrow({ where: { id: newListing.id }, include: { images: imagesInclude } })))
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

    // One choice of a product only has its own price and stock; the rest belongs to the product.
    if (listing.parentId !== null && (title !== undefined || description !== undefined || category !== undefined || imageUrl !== undefined || req.body.imageUrls !== undefined)) {
        res.status(400).send({message: ownedByOptionsMessage, code:"LISTING_IS_OPTION"})
        return
    }

    // A product with options is priced and stocked on its options.
    if ((price !== undefined || stockQuantity !== undefined) && (await countChoices(id)) > 0) {
        res.status(400).send({message:"This product has options. Change price and stock on each option, with PUT /listings/:id/options", code:"LISTING_HAS_OPTIONS"})
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
        const needsPropagation = title !== undefined || description !== undefined || category !== undefined || photos !== undefined
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
                    throw new ReservedStockConflict(reservedQuantity, "this listing")
                }

                return tx.listing.update({
                    where: { id },
                    data,
                    include: { images: imagesInclude }
                })
            }, {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable
            })
            : await prisma.$transaction(async (tx) => {
                const updated = await tx.listing.update({ where: { id }, data, include: { images: imagesInclude } })

                if (needsPropagation) {
                    await propagateToOptions(tx, listing, updated)
                }

                return updated
            })

        res.send(await detailedListing(updatedListing))
    }catch (error){
        if (error instanceof ReservedStockConflict) {
            res.status(409).send({
                message: `Stock quantity cannot be less than ${error.reservedQuantity} units currently reserved`,
                ...(error.label === "this listing" ? {} : { option: error.label })
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

    if (listing.parentId !== null) {
        res.status(400).send({message: "This is one choice of a product. Remove it with PUT /listings/:id/options on the product", code:"LISTING_IS_OPTION"})
        return
    }

    try{
        await prisma.$transaction(async (tx) => {
            const choiceIds = (await tx.listing.findMany({ where: { parentId: id }, select: { id: true } })).map((choice) => choice.id)
            await tx.cartItem.deleteMany({ where: { listingId: { in: [id, ...choiceIds] } } })
            await tx.listing.deleteMany({ where: { parentId: id } })
            await tx.listing.delete({where: {id}})
        })
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
                parentId: null,
                ...(archived === "only" ? { archivedAt: { not: null } } : archived === "all" ? {} : { archivedAt: null })
            },
            include: { images: imagesInclude }
        })
        const choices = await loadChoices(listings.map((listing) => listing.id))
        res.send(listings.map((listing) => ({ ...withOptionSummary(withImages(listing), choices.get(listing.id)), options: optionTree(choices.get(listing.id)) })))
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

    if (listing.parentId !== null) {
        res.status(400).send({message: "This is one choice of a product. Remove it with PUT /listings/:id/options on the product", code:"LISTING_IS_OPTION"})
        return
    }

    try{
        const archived = await prisma.$transaction(async (tx) => {
            const at = listing.archivedAt ?? new Date()
            const choiceIds = (await tx.listing.findMany({ where: { parentId: id }, select: { id: true } })).map((choice) => choice.id)
            await tx.cartItem.deleteMany({ where: { listingId: { in: [id, ...choiceIds] } } })
            // The choices get the same time as the product, so putting the product back restores exactly these.
            await tx.listing.updateMany({ where: { parentId: id, archivedAt: null }, data: { archivedAt: at } })
            return tx.listing.update({ where: { id }, data: { archivedAt: at }, include: { images: imagesInclude } })
        })
        res.send({message:"Listing archived", listing: await detailedListing(archived)})
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

    if (listing.parentId !== null) {
        res.status(400).send({message: "This is one choice of a product. Change it with PUT /listings/:id/options on the product", code:"LISTING_IS_OPTION"})
        return
    }

    try{
        const restored = await prisma.$transaction(async (tx) => {
            // Only the choices that went off sale together with the product come back; ones the seller removed stay removed.
            if (listing.archivedAt) {
                await tx.listing.updateMany({ where: { parentId: id, archivedAt: listing.archivedAt }, data: { archivedAt: null } })
            }

            return tx.listing.update({ where: { id }, data: { archivedAt: null }, include: { images: imagesInclude } })
        })
        res.send({message:"Listing restored", listing: await detailedListing(restored)})
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}

// Replaces the options of a product with the list sent: new ones are created, ones with the same name are updated
// (price, photo, stock), and ones that are missing are removed (or hidden when a cart, checkout or order has used
// them). An empty list takes all options away; the product then needs its own stockQuantity.
export const setListingOptions = async(req: Request, res: Response) =>{
    const id = Number(req.params.id)

    if(!Number.isSafeInteger(id)){
        res.status(400).send({message:"Id has to be a number"})
        return
    }

    const listing = await prisma.listing.findUnique({ where: { id }, include: { images: imagesInclude } })

    if (!listing) {
        res.status(404).send({message:"Listing not found"})
        return
    }

    if (listing.userId !== req.user!.id) {
        res.status(403).send({message:"You are not allowed to edit this listing"})
        return
    }

    if (listing.parentId !== null) {
        res.status(400).send({message: "Options are set on the product, not on one of its choices", code:"LISTING_IS_OPTION"})
        return
    }

    const defaultPrice = req.body.price === undefined ? listing.price : Number(req.body.price)
    const priceError = req.body.price === undefined ? null : priceProblem(req.body.price)

    if (priceError) {
        res.status(400).send({message: priceError})
        return
    }

    const options = readOptions(req.body.options, defaultPrice)

    if ("error" in options) {
        res.status(400).send({message: options.error})
        return
    }

    if (options.length === 0) {
        const stockError = stockProblem(req.body.stockQuantity)

        if (stockError) {
            res.status(400).send({message: "Without options the product needs a stock quantity. " + stockError})
            return
        }
    }

    try{
        await prisma.$transaction(async (tx) => {
            await syncListingOptions(tx, listing, options)

            if (options.length === 0) {
                await tx.listing.update({ where: { id }, data: { stockQuantity: req.body.stockQuantity, ...(req.body.price === undefined ? {} : { price: defaultPrice }) } })
            }
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        })

        res.send(await detailedListing(await prisma.listing.findUniqueOrThrow({ where: { id }, include: { images: imagesInclude } })))
    }catch(error){
        if (error instanceof ReservedStockConflict) {
            res.status(409).send({
                message: `Stock for ${error.label} cannot be less than ${error.reservedQuantity} units currently reserved`,
                option: error.label
            })
            return
        }

        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
            res.status(409).send({ message: "Inventory changed while updating stock. Please try again." })
            return
        }

        console.error("setListingOptions failed unexpectedly", { listingId: id }, error)
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}

