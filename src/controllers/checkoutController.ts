import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma } from "../generated/prisma/client.js"
import { buildLocation } from "../lib/nigeriaLocation.js"

const checkoutListingSelect = {
    id: true,
    title: true,
    description: true,
    price: true,
    stockQuantity: true,
    category: true,
    imageUrl: true,
    user: {
        select: {
            id: true,
            sellerProfile: {
                select: {
                    businessName: true,
                    slug: true,
                    shippingPolicy: true,
                    shippingCost: true
                }
            }
        }
    }
} as const

type PreviewItem = {
    listingId: number
    title: string
    description: string
    imageUrl: string
    category: string
    unitPrice: string
    quantity: number
    lineSubtotal: string
    stockQuantity: number
    availableQuantity: number
}

type SellerPreview = {
    sellerId: number
    seller: {
        businessName: string
        slug: string
    }
    items: PreviewItem[]
    subtotal: Prisma.Decimal
    shipping: Prisma.Decimal
}

type DeliveryInput = {
    fullName: string
    phone: string
    address: string
    state: string
    lga: string
    instructions: string | null
}

class CheckoutCreationError extends Error {
    constructor(
        readonly statusCode: number,
        message: string
    ) {
        super(message)
    }
}

function formatMoney(amount: Prisma.Decimal): string {
    return amount.toFixed(2)
}

async function expireExpiredCheckouts(userId: number, now = new Date()): Promise<void> {
    await prisma.$transaction(async (tx) => {
        const expiredCheckouts = await tx.checkout.findMany({
            where: {
                userId,
                status: { in: ["PENDING", "PAYMENT_PENDING"] },
                expiresAt: { lte: now }
            },
            select: { id: true }
        })

        for (const checkout of expiredCheckouts) {
            const transition = await tx.checkout.updateMany({
                where: {
                    id: checkout.id,
                    userId,
                    status: { in: ["PENDING", "PAYMENT_PENDING"] },
                    expiresAt: { lte: now }
                },
                data: { status: "EXPIRED" }
            })

            if (transition.count === 0) {
                continue
            }

            await tx.inventoryReservation.updateMany({
                where: {
                    checkoutId: checkout.id,
                    status: "ACTIVE",
                    expiresAt: { lte: now }
                },
                data: { status: "EXPIRED" }
            })

            await tx.order.updateMany({
                where: {
                    checkoutId: checkout.id,
                    status: "PENDING_PAYMENT"
                },
                data: { status: "CANCELLED" }
            })
        }
    }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    })
}

function parseDelivery(body: unknown): DeliveryInput | null {
    if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("delivery" in body)
    ) {
        return null
    }

    const delivery = body.delivery

    if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
        return null
    }

    const fields = delivery as Record<string, unknown>
    const allowedFields = ["fullName", "phone", "address", "state", "lga", "instructions"]

    if (
        Object.keys(fields).some((field) => !allowedFields.includes(field)) ||
        typeof fields.fullName !== "string" ||
        !fields.fullName.trim() ||
        typeof fields.phone !== "string" ||
        !fields.phone.trim() ||
        typeof fields.address !== "string" ||
        !fields.address.trim() ||
        typeof fields.state !== "string" ||
        typeof fields.lga !== "string" ||
        (fields.instructions !== undefined && typeof fields.instructions !== "string")
    ) {
        return null
    }

    const state = fields.state.trim()
    const lga = fields.lga.trim()

    if (!buildLocation(state, lga)) {
        return null
    }

    return {
        fullName: fields.fullName.trim(),
        phone: fields.phone.trim(),
        address: fields.address.trim(),
        state,
        lga,
        instructions: typeof fields.instructions === "string" && fields.instructions.trim()
            ? fields.instructions.trim()
            : null
    }
}

export async function createCheckout(req: Request, res: Response) {
    const userId = req.user?.id

    if (!userId) {
        res.status(401).send({ message: "Authentication required" })
        return
    }

    const delivery = parseDelivery(req.body)

    if (!delivery) {
        res.status(400).send({
            message: "Provide valid delivery fullName, phone, address, state, lga, and optional instructions"
        })
        return
    }

    try {
        await expireExpiredCheckouts(userId)

        const result = await prisma.$transaction(async (tx) => {
            const cart = await tx.cart.findUnique({
                where: { userId },
                select: {
                    cartItems: {
                        select: {
                            listingId: true,
                            quantity: true,
                            listing: {
                                select: checkoutListingSelect
                            }
                        }
                    }
                }
            })

            if (!cart || cart.cartItems.length === 0) {
                throw new CheckoutCreationError(400, "Cart is empty")
            }

            const listingIds = cart.cartItems.map(({ listingId }) => listingId)
            const reservationCheckTime = new Date()
            const activeReservations = await tx.inventoryReservation.findMany({
                where: {
                    listingId: { in: listingIds },
                    status: "ACTIVE",
                    expiresAt: { gt: reservationCheckTime }
                },
                select: {
                    listingId: true,
                    quantity: true
                }
            })
            const reservedQuantities = new Map<number, number>()

            for (const reservation of activeReservations) {
                reservedQuantities.set(
                    reservation.listingId,
                    (reservedQuantities.get(reservation.listingId) ?? 0) + reservation.quantity
                )
            }

            const sellers = new Map<number, SellerPreview>()

            for (const cartItem of cart.cartItems) {
                const listing = cartItem.listing
                const sellerProfile = listing.user.sellerProfile
                const reservedQuantity = reservedQuantities.get(listing.id) ?? 0
                const availableQuantity = Math.max(listing.stockQuantity - reservedQuantity, 0)

                if (
                    !Number.isSafeInteger(cartItem.quantity) ||
                    cartItem.quantity < 1 ||
                    !Number.isSafeInteger(listing.stockQuantity) ||
                    listing.stockQuantity < 0 ||
                    !Number.isFinite(listing.price) ||
                    listing.price <= 0 ||
                    cartItem.quantity > availableQuantity
                ) {
                    throw new CheckoutCreationError(
                        409,
                        `Listing ${cartItem.listingId} is unavailable in the requested quantity`
                    )
                }

                if (!sellerProfile) {
                    throw new CheckoutCreationError(
                        409,
                        `Listing ${cartItem.listingId} does not have an available seller storefront`
                    )
                }

                let sellerPreview = sellers.get(listing.user.id)

                if (!sellerPreview) {
                    let shipping: Prisma.Decimal

                    if (sellerProfile.shippingPolicy === "FREE") {
                        shipping = new Prisma.Decimal(0)
                    } else if (
                        sellerProfile.shippingPolicy === "FIXED" &&
                        sellerProfile.shippingCost !== null &&
                        sellerProfile.shippingCost.greaterThanOrEqualTo(0)
                    ) {
                        shipping = sellerProfile.shippingCost.toDecimalPlaces(2)
                    } else {
                        throw new CheckoutCreationError(
                            409,
                            `Shipping information is unavailable for ${sellerProfile.businessName}`
                        )
                    }

                    sellerPreview = {
                        sellerId: listing.user.id,
                        seller: {
                            businessName: sellerProfile.businessName,
                            slug: sellerProfile.slug
                        },
                        items: [],
                        subtotal: new Prisma.Decimal(0),
                        shipping
                    }
                    sellers.set(listing.user.id, sellerPreview)
                }

                const unitPrice = new Prisma.Decimal(listing.price.toString()).toDecimalPlaces(2)
                const lineSubtotal = unitPrice.times(cartItem.quantity)

                sellerPreview.items.push({
                    listingId: listing.id,
                    title: listing.title,
                    description: listing.description,
                    imageUrl: listing.imageUrl,
                    category: listing.category,
                    unitPrice: formatMoney(unitPrice),
                    quantity: cartItem.quantity,
                    lineSubtotal: formatMoney(lineSubtotal),
                    stockQuantity: listing.stockQuantity,
                    availableQuantity
                })
                sellerPreview.subtotal = sellerPreview.subtotal.plus(lineSubtotal)
            }

            const sellerPreviews = Array.from(sellers.values())
            const subtotal = sellerPreviews.reduce(
                (total, seller) => total.plus(seller.subtotal),
                new Prisma.Decimal(0)
            )
            const shipping = sellerPreviews.reduce(
                (total, seller) => total.plus(seller.shipping),
                new Prisma.Decimal(0)
            )
            const total = subtotal.plus(shipping)
            const decimalMaximum = new Prisma.Decimal("9999999999.99")

            if (
                [subtotal, shipping, total, ...sellerPreviews.flatMap((seller) => [seller.subtotal, seller.shipping])]
                    .some((amount) => amount.greaterThan(decimalMaximum))
            ) {
                throw new CheckoutCreationError(409, "Checkout total exceeds the supported payment amount")
            }

            const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
            const checkout = await tx.checkout.create({
                data: {
                    userId,
                    status: "PENDING",
                    expiresAt,
                    deliveryName: delivery.fullName,
                    deliveryPhone: delivery.phone,
                    deliveryAddress: delivery.address,
                    deliveryState: delivery.state,
                    deliveryLga: delivery.lga,
                    deliveryInstructions: delivery.instructions,
                    total
                }
            })

            await tx.checkoutItem.createMany({
                data: cart.cartItems.map(({ listingId, quantity, listing }) => ({
                    checkoutId: checkout.id,
                    listingId,
                    title: listing.title,
                    unitPrice: new Prisma.Decimal(listing.price.toString()).toDecimalPlaces(2),
                    quantity
                }))
            })

            await tx.inventoryReservation.createMany({
                data: cart.cartItems.map(({ listingId, quantity }) => ({
                    checkoutId: checkout.id,
                    listingId,
                    quantity,
                    status: "ACTIVE",
                    expiresAt
                }))
            })

            const createdOrders = []

            for (const seller of sellerPreviews) {
                const orderTotal = seller.subtotal.plus(seller.shipping)
                const order = await tx.order.create({
                    data: {
                        checkoutId: checkout.id,
                        sellerId: seller.sellerId,
                        status: "PENDING_PAYMENT",
                        subtotal: seller.subtotal,
                        shippingCost: seller.shipping,
                        total: orderTotal,
                        deliveryName: delivery.fullName,
                        deliveryPhone: delivery.phone,
                        deliveryAddress: delivery.address,
                        deliveryState: delivery.state,
                        deliveryLga: delivery.lga,
                        deliveryInstructions: delivery.instructions
                    },
                    select: { id: true }
                })

                await tx.orderItem.createMany({
                    data: cart.cartItems
                        .filter(({ listing }) => listing.user.id === seller.sellerId)
                        .map(({ listingId, quantity, listing }) => ({
                            orderId: order.id,
                            listingId,
                            title: listing.title,
                            unitPrice: new Prisma.Decimal(listing.price.toString()).toDecimalPlaces(2),
                            quantity
                        }))
                })

                createdOrders.push({
                    id: order.id,
                    seller: seller.seller,
                    status: "PENDING_PAYMENT" as const,
                    subtotal: formatMoney(seller.subtotal),
                    shipping: formatMoney(seller.shipping),
                    total: formatMoney(orderTotal)
                })
            }

            return {
                checkout: {
                    id: checkout.id,
                    status: checkout.status,
                    expiresAt: checkout.expiresAt,
                    delivery: {
                        fullName: checkout.deliveryName,
                        phone: checkout.deliveryPhone,
                        address: checkout.deliveryAddress,
                        state: checkout.deliveryState,
                        lga: checkout.deliveryLga,
                        instructions: checkout.deliveryInstructions
                    }
                },
                subtotal: formatMoney(subtotal),
                shipping: formatMoney(shipping),
                total: formatMoney(total),
                orders: createdOrders
            }
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        })

        res.status(201).send(result)
    } catch (error) {
        if (error instanceof CheckoutCreationError) {
            res.status(error.statusCode).send({ message: error.message })
            return
        }

        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
            res.status(409).send({
                message: "Checkout state changed while creating checkout. Please try again."
            })
            return
        }

        console.error(error)
        res.status(500).send({
            message: "Sorry, there is an issue on our end"
        })
    }
}

export async function getCheckoutPreview(req: Request, res: Response) {
    const userId = req.user?.id

    if (!userId) {
        res.status(401).send({ message: "Authentication required" })
        return
    }

    try {
        await expireExpiredCheckouts(userId)

        const cart = await prisma.cart.findUnique({
            where: { userId },
            select: {
                cartItems: {
                    select: {
                        listingId: true,
                        quantity: true,
                        listing: {
                            select: checkoutListingSelect
                        }
                    }
                }
            }
        })

        if (!cart || cart.cartItems.length === 0) {
            res.status(400).send({ message: "Cart is empty" })
            return
        }

        const listingIds = [...new Set(cart.cartItems.map(({ listingId }) => listingId))]
        const activeReservations = await prisma.inventoryReservation.findMany({
            where: {
                listingId: { in: listingIds },
                status: "ACTIVE",
                expiresAt: { gt: new Date() }
            },
            select: {
                listingId: true,
                quantity: true
            }
        })
        const reservedQuantities = new Map<number, number>()

        for (const reservation of activeReservations) {
            reservedQuantities.set(
                reservation.listingId,
                (reservedQuantities.get(reservation.listingId) ?? 0) + reservation.quantity
            )
        }

        const sellers = new Map<number, SellerPreview>()

        for (const cartItem of cart.cartItems) {
            const listing = cartItem.listing
            const sellerProfile = listing.user.sellerProfile
            const availableQuantity = Math.max(
                listing.stockQuantity - (reservedQuantities.get(listing.id) ?? 0),
                0
            )

            if (
                !Number.isSafeInteger(cartItem.quantity) ||
                cartItem.quantity < 1 ||
                !Number.isFinite(listing.price) ||
                listing.price <= 0 ||
                cartItem.quantity > availableQuantity
            ) {
                res.status(409).send({
                    message: `Listing ${cartItem.listingId} is unavailable in the requested quantity`
                })
                return
            }

            if (!sellerProfile) {
                res.status(409).send({
                    message: `Listing ${cartItem.listingId} does not have an available seller storefront`
                })
                return
            }

            let sellerPreview = sellers.get(listing.user.id)

            if (!sellerPreview) {
                let shipping: Prisma.Decimal

                if (sellerProfile.shippingPolicy === "FREE") {
                    shipping = new Prisma.Decimal(0)
                } else if (
                    sellerProfile.shippingPolicy === "FIXED" &&
                    sellerProfile.shippingCost !== null &&
                    sellerProfile.shippingCost.greaterThanOrEqualTo(0)
                ) {
                    shipping = sellerProfile.shippingCost.toDecimalPlaces(2)
                } else {
                    res.status(409).send({
                        message: `Shipping information is unavailable for ${sellerProfile.businessName}`
                    })
                    return
                }

                sellerPreview = {
                    sellerId: listing.user.id,
                    seller: {
                        businessName: sellerProfile.businessName,
                        slug: sellerProfile.slug
                    },
                    items: [],
                    subtotal: new Prisma.Decimal(0),
                    shipping
                }
                sellers.set(listing.user.id, sellerPreview)
            }

            const unitPrice = new Prisma.Decimal(listing.price.toString()).toDecimalPlaces(2)
            const lineSubtotal = unitPrice.times(cartItem.quantity)

            sellerPreview.items.push({
                listingId: listing.id,
                title: listing.title,
                description: listing.description,
                imageUrl: listing.imageUrl,
                category: listing.category,
                unitPrice: formatMoney(unitPrice),
                quantity: cartItem.quantity,
                lineSubtotal: formatMoney(lineSubtotal),
                stockQuantity: listing.stockQuantity,
                availableQuantity
            })
            sellerPreview.subtotal = sellerPreview.subtotal.plus(lineSubtotal)
        }

        const sellerGroups = Array.from(sellers.values()).map((sellerPreview) => {
            const total = sellerPreview.subtotal.plus(sellerPreview.shipping)

            return {
                seller: sellerPreview.seller,
                items: sellerPreview.items,
                subtotal: formatMoney(sellerPreview.subtotal),
                shipping: formatMoney(sellerPreview.shipping),
                total: formatMoney(total)
            }
        })

        const subtotal = Array.from(sellers.values()).reduce(
            (total, sellerPreview) => total.plus(sellerPreview.subtotal),
            new Prisma.Decimal(0)
        )
        const shipping = Array.from(sellers.values()).reduce(
            (total, sellerPreview) => total.plus(sellerPreview.shipping),
            new Prisma.Decimal(0)
        )

        res.send({
            sellers: sellerGroups,
            subtotal: formatMoney(subtotal),
            shipping: formatMoney(shipping),
            total: formatMoney(subtotal.plus(shipping))
        })
    } catch (error) {
        console.error(error)

        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
            res.status(409).send({
                message: "Checkout state changed while loading your cart. Please try again."
            })
            return
        }

        res.status(500).send({
            message: "Sorry, there is an issue on our end"
        })
    }
}
