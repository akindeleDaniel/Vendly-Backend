import prisma from "../lib/prisma.js"
import type { Request, Response } from "express"
import { Prisma } from "../generated/prisma/client.js"
import { makeSlug } from "../lib/generateSlug.js"
import { buildLocation } from "../lib/nigeriaLocation.js"
import { geocodeLocation } from "../lib/geocoding.js"
import { haversineDistance } from "../lib/distance.js"
import { getDrivingRouteDistances, getRouteCandidateLimit } from "../lib/routeMatrix.js"

function hasValidCoordinates<T extends { latitude: number | null; longitude: number | null }>(
    shop: T
): shop is T & { latitude: number; longitude: number } {
    return shop.latitude !== null &&
        shop.longitude !== null &&
        Number.isFinite(shop.latitude) &&
        Number.isFinite(shop.longitude) &&
        shop.latitude >= -90 &&
        shop.latitude <= 90 &&
        shop.longitude >= -180 &&
        shop.longitude <= 180
}

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

    const coordinates = await geocodeLocation(location)
    
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
            slug,
            latitude: coordinates?.latitude ?? null,
            longitude: coordinates?.longitude ?? null
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

        const locationChanged = newState !== existingProfile.state || newLga !== existingProfile.lga
        const shouldGeocode = locationChanged || existingProfile.latitude === null || existingProfile.longitude === null
        const coordinates = shouldGeocode ? await geocodeLocation(location) : null
        const coordinateData = shouldGeocode
            ? {
                latitude: coordinates?.latitude ?? null,
                longitude: coordinates?.longitude ?? null
            }
            : {}

        const updatedProfile = await prisma.sellerProfile.update({
            where:{userId: req.user!.id},
            data:{businessName, state, lga, logoUrl, location, ...coordinateData}
        })

        res.send(updatedProfile)
    }catch(error){
        res.status(500).send({message:"Sorry there is an issue on our end"})
    }
}

export const getPublicShop = async (req: Request, res: Response) => {
    const slug = String(req.params.slug)

    try{
        const profile = await prisma.sellerProfile.findUnique({
            where:{slug},
            select:{
                id:true,
                userId:true,
                businessName:true,
                state:true,
                lga:true,
                location:true,
                logoUrl:true,
                slug:true
            }
        })

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

export const getCategoryShops = async (req: Request, res: Response) => {
    const category = req.query.category
    const latitudeQuery = req.query.latitude
    const longitudeQuery = req.query.longitude

    if (typeof category !== "string" || !category.trim()) {
        res.status(400).send({ message: "A category is required" })
        return
    }

    const hasLatitude = latitudeQuery !== undefined
    const hasLongitude = longitudeQuery !== undefined

    if (hasLatitude !== hasLongitude) {
        res.status(400).send({ message: "Latitude and longitude must be provided together" })
        return
    }

    let consumerCoordinates: { latitude: number; longitude: number } | null = null

    if (hasLatitude && hasLongitude) {
        if (
            typeof latitudeQuery !== "string" ||
            typeof longitudeQuery !== "string" ||
            !latitudeQuery.trim() ||
            !longitudeQuery.trim()
        ) {
            res.status(400).send({ message: "Latitude and longitude must be valid coordinates" })
            return
        }

        const latitude = Number(latitudeQuery)
        const longitude = Number(longitudeQuery)

        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180
        ) {
            res.status(400).send({ message: "Latitude and longitude must be valid coordinates" })
            return
        }

        consumerCoordinates = { latitude, longitude }
    }

    try {
        const shops = await prisma.sellerProfile.findMany({
            where: {
                user: {
                    listings: {
                        some: {
                            category: {
                                contains: category.trim(),
                                mode: "insensitive"
                            }
                        }
                    }
                }
            },
            select: {
                id: true,
                businessName: true,
                state: true,
                lga: true,
                location: true,
                logoUrl: true,
                slug: true,
                latitude: true,
                longitude: true
            },
            orderBy: [{ businessName: "asc" }, { id: "asc" }]
        })

        if (!consumerCoordinates || shops.length === 0) {
            res.send(shops.map(({ latitude: _latitude, longitude: _longitude, ...shop }) => shop))
            return
        }

        const routeableShops = shops.filter(hasValidCoordinates)
        const candidateLimit = getRouteCandidateLimit(shops.length)
        const candidates = routeableShops
            .map((shop, originalIndex) => ({
                shop,
                originalIndex,
                approximateDistance: haversineDistance(
                    consumerCoordinates.latitude,
                    consumerCoordinates.longitude,
                    shop.latitude,
                    shop.longitude
                )
            }))
            .sort((a, b) => a.approximateDistance - b.approximateDistance || a.originalIndex - b.originalIndex)
            .slice(0, candidateLimit)

        if (candidates.length === 0) {
            res.send(shops.map(({ latitude: _latitude, longitude: _longitude, ...shop }) => shop))
            return
        }

        let orderedCandidates: typeof candidates

        try {
            const distances = await getDrivingRouteDistances(
                consumerCoordinates,
                candidates.map(({ shop }) => ({
                    latitude: shop.latitude,
                    longitude: shop.longitude
                }))
            )

            orderedCandidates = candidates
                .map((candidate, index) => ({
                    ...candidate,
                    routeDistance: distances[index] ?? null
                }))
                .sort((a, b) => {
                    if (a.routeDistance === null) return b.routeDistance === null ? a.originalIndex - b.originalIndex : 1
                    if (b.routeDistance === null) return -1
                    return a.routeDistance - b.routeDistance || a.originalIndex - b.originalIndex
                })
        } catch {
            console.warn("Geoapify route matrix failed; using category shop ordering")
            res.send(shops.map(({ latitude: _latitude, longitude: _longitude, ...shop }) => shop))
            return
        }

        const candidateIds = new Set(candidates.map(({ shop }) => shop.id))
        const remainingShops = shops.filter((shop) => !candidateIds.has(shop.id))
        const orderedShops = [
            ...orderedCandidates.map(({ shop }) => shop),
            ...remainingShops
        ]

        res.send(orderedShops.map(({ latitude: _latitude, longitude: _longitude, ...shop }) => shop))
    } catch {
        res.status(500).send({ message: "Sorry there is an issue on our end" })
    }
}
