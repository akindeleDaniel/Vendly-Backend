import type { Request, Response } from "express"
import { createHash } from "node:crypto"
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

type CheckoutReview = {
    reviewToken: string
    sellers: Array<{
        seller: SellerPreview["seller"]
        items: PreviewItem[]
        subtotal: string
        shipping: string
        total: string
    }>
    subtotal: string
    shipping: string
    total: string
}

class CheckoutCreationError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
        readonly code?: string,
        readonly review?: CheckoutReview
    ) {
        super(message)
    }
}

type CheckoutRequest = {
    delivery: DeliveryInput
    reviewToken: string | null
}

function formatMoney(amount: Prisma.Decimal): string {
    return amount.toFixed(2)
}

function sortCartItems<T extends { listingId: number; quantity: number }>(items: T[]): T[] {
    return [...items].sort((left, right) => left.listingId - right.listingId)
}

function createReviewToken(
    userId: number,
    items: Array<{
        listingId: number
        quantity: number
        unitPrice: string
        stockQuantity: number
        availableQuantity: number
    }>,
    sellers: Array<{ sellerId: number; shipping: Prisma.Decimal }>
): string {
    const snapshot = {
        userId,
        items: sortCartItems(items).map(({
            listingId,
            quantity,
            unitPrice,
            stockQuantity,
            availableQuantity
        }) => ({
            listingId,
            quantity,
            unitPrice,
            stockQuantity,
            availableQuantity
        })),
        sellers: [...sellers]
            .sort((left, right) => left.sellerId - right.sellerId)
            .map(({ sellerId, shipping }) => ({ sellerId, shipping: formatMoney(shipping) }))
    }

    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
}

function buildCheckoutReview(
    userId: number,
    sellers: SellerPreview[]
): CheckoutReview {
    const sortedSellers = [...sellers].sort((left, right) => left.sellerId - right.sellerId)
    const sellerGroups = sortedSellers.map((seller) => {
        const total = seller.subtotal.plus(seller.shipping)

        return {
            seller: seller.seller,
            items: [...seller.items].sort((left, right) => left.listingId - right.listingId),
            subtotal: formatMoney(seller.subtotal),
            shipping: formatMoney(seller.shipping),
            total: formatMoney(total)
        }
    })
    const subtotal = sortedSellers.reduce(
        (total, seller) => total.plus(seller.subtotal),
        new Prisma.Decimal(0)
    )
    const shipping = sortedSellers.reduce(
        (total, seller) => total.plus(seller.shipping),
        new Prisma.Decimal(0)
    )
    const items = sortedSellers.flatMap((seller) => seller.items)
    const reviewToken = createReviewToken(
        userId,
        items.map(({
            listingId,
            quantity,
            unitPrice,
            stockQuantity,
            availableQuantity
        }) => ({
            listingId,
            quantity,
            unitPrice,
            stockQuantity,
            availableQuantity
        })),
        sortedSellers.map(({ sellerId, shipping: sellerShipping }) => ({
            sellerId,
            shipping: sellerShipping
        }))
    )

    return {
        reviewToken,
        sellers: sellerGroups,
        subtotal: formatMoney(subtotal),
        shipping: formatMoney(shipping),
        total: formatMoney(subtotal.plus(shipping))
    }
}

function deliveryMatchesCheckout(delivery: DeliveryInput, checkout: {
    deliveryName: string
    deliveryPhone: string
    deliveryAddress: string
    deliveryState: string
    deliveryLga: string
    deliveryInstructions: string | null
}): boolean {
    return delivery.fullName === checkout.deliveryName &&
        delivery.phone === checkout.deliveryPhone &&
        delivery.address === checkout.deliveryAddress &&
        delivery.state === checkout.deliveryState &&
        delivery.lga === checkout.deliveryLga &&
        delivery.instructions === checkout.deliveryInstructions
}

async function acquireCheckoutCreationLock(tx: Prisma.TransactionClient, userId: number): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(1447380556, ${userId})`
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

function parseCheckoutRequest(body: unknown): CheckoutRequest | null {
    if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((field) => field !== "delivery" && field !== "reviewToken") ||
        !("delivery" in body)
    ) {
        return null
    }

    const fields = body as Record<string, unknown>
    const delivery = fields.delivery

    if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
        return null
    }

    const deliveryFields = delivery as Record<string, unknown>
    const allowedFields = ["fullName", "phone", "address", "state", "lga", "instructions"]

    if (
        Object.keys(deliveryFields).some((field) => !allowedFields.includes(field)) ||
        typeof deliveryFields.fullName !== "string" ||
        !deliveryFields.fullName.trim() ||
        typeof deliveryFields.phone !== "string" ||
        !deliveryFields.phone.trim() ||
        typeof deliveryFields.address !== "string" ||
        !deliveryFields.address.trim() ||
        typeof deliveryFields.state !== "string" ||
        typeof deliveryFields.lga !== "string" ||
        (deliveryFields.instructions !== undefined && typeof deliveryFields.instructions !== "string") ||
        (fields.reviewToken !== undefined &&
            (typeof fields.reviewToken !== "string" || !/^[a-f0-9]{64}$/.test(fields.reviewToken)))
    ) {
        return null
    }

    const state = deliveryFields.state.trim()
    const lga = deliveryFields.lga.trim()

    if (!buildLocation(state, lga)) {
        return null
    }

    return {
        delivery: {
            fullName: deliveryFields.fullName.trim(),
            phone: deliveryFields.phone.trim(),
            address: deliveryFields.address.trim(),
            state,
            lga,
            instructions: typeof deliveryFields.instructions === "string" && deliveryFields.instructions.trim()
                ? deliveryFields.instructions.trim()
                : null
        },
        reviewToken: typeof fields.reviewToken === "string" ? fields.reviewToken : null
    }
}

export async function createCheckout(req: Request, res: Response) {
    const userId = req.user?.id

    if (!userId) {
        res.status(401).send({ message: "Authentication required" })
        return
    }

    const checkoutRequest = parseCheckoutRequest(req.body)

    if (!checkoutRequest) {
        res.status(400).send({
            message: "Provide valid delivery details and, if supplied, a valid review token"
        })
        return
    }

    const { delivery, reviewToken } = checkoutRequest

    try {
        await expireExpiredCheckouts(userId)

        const result = await prisma.$transaction(async (tx) => {
            await acquireCheckoutCreationLock(tx, userId)

            const now = new Date()
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

            const existingCheckouts = await tx.checkout.findMany({
                where: {
                    userId,
                    status: { in: ["PENDING", "PAYMENT_PENDING"] },
                    expiresAt: { gt: now }
                },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                include: {
                    checkoutItems: {
                        orderBy: { listingId: "asc" },
                        select: {
                            listingId: true,
                            title: true,
                            unitPrice: true,
                            quantity: true
                        }
                    },
                    inventoryReservations: {
                        select: {
                            listingId: true,
                            quantity: true,
                            status: true,
                            expiresAt: true
                        }
                    },
                    orders: {
                        orderBy: { id: "asc" },
                        include: {
                            seller: {
                                select: {
                                    sellerProfile: {
                                        select: { businessName: true, slug: true }
                                    }
                                }
                            },
                            orderItems: {
                                orderBy: { listingId: "asc" },
                                select: {
                                    listingId: true,
                                    title: true,
                                    unitPrice: true,
                                    quantity: true
                                }
                            }
                        }
                    },
                    paymentAttempts: {
                        select: { status: true }
                    }
                }
            })

            const replaceableCheckoutIds = existingCheckouts.map(({ id }) => id)
            const listingIds = cart.cartItems.map(({ listingId }) => listingId)
            const activeReservations = await tx.inventoryReservation.findMany({
                where: {
                    listingId: { in: listingIds },
                    status: "ACTIVE",
                    expiresAt: { gt: now },
                    ...(replaceableCheckoutIds.length > 0
                        ? { checkoutId: { notIn: replaceableCheckoutIds } }
                        : {})
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

            const review = buildCheckoutReview(userId, sellerPreviews)
            const cartSnapshot = sortCartItems(cart.cartItems)
            const hasSameCart = (checkout: typeof existingCheckouts[number]) => {
                const savedItems = sortCartItems(checkout.checkoutItems)
                return savedItems.length === cartSnapshot.length &&
                    savedItems.every((item, index) =>
                        item.listingId === cartSnapshot[index]?.listingId &&
                        item.quantity === cartSnapshot[index]?.quantity
                    )
            }
            const hasSamePricesAndShipping = (checkout: typeof existingCheckouts[number]) => {
                const savedItems = sortCartItems(checkout.checkoutItems)
                const currentItems = sortCartItems(cart.cartItems)
                const pricesMatch = savedItems.length === currentItems.length &&
                    savedItems.every((item, index) => {
                        const current = currentItems[index]
                        return current !== undefined &&
                            item.listingId === current.listingId &&
                            item.unitPrice.equals(
                                new Prisma.Decimal(current.listing.price.toString()).toDecimalPlaces(2)
                            )
                    })
                const savedShipping = new Map(
                    checkout.orders.map((order) => [order.sellerId, order.shippingCost])
                )
                const shippingMatches = checkout.orders.length === sellerPreviews.length &&
                    sellerPreviews.length === savedShipping.size &&
                    sellerPreviews.every((seller) =>
                        savedShipping.get(seller.sellerId)?.equals(seller.shipping) === true
                    )

                return pricesMatch && shippingMatches
            }
            const reservationsMatch = (checkout: typeof existingCheckouts[number]) => {
                const activeReservations = sortCartItems(
                    checkout.inventoryReservations
                        .filter((reservation) => reservation.status === "ACTIVE" && reservation.expiresAt > now)
                        .map(({ listingId, quantity }) => ({ listingId, quantity }))
                )
                const cartItems = sortCartItems(cart.cartItems)
                return activeReservations.length === cartItems.length &&
                    activeReservations.every((reservation, index) =>
                        reservation.listingId === cartItems[index]?.listingId &&
                        reservation.quantity === cartItems[index]?.quantity
                    )
            }

            const hasMatchingCartAndDelivery = existingCheckouts.some((checkout) =>
                hasSameCart(checkout) && deliveryMatchesCheckout(delivery, checkout)
            )

            if (
                !hasMatchingCartAndDelivery &&
                existingCheckouts.some((checkout) => !deliveryMatchesCheckout(delivery, checkout))
            ) {
                throw new CheckoutCreationError(
                    409,
                    "Delivery details differ from an existing checkout",
                    "CHECKOUT_CONFLICT"
                )
            }

            if (reviewToken !== review.reviewToken) {
                throw new CheckoutCreationError(
                    409,
                    "Review the current cart prices and confirm before continuing",
                    "CHECKOUT_REVIEW_REQUIRED",
                    review
                )
            }

            const reusableCheckout = existingCheckouts.find((checkout) =>
                hasSameCart(checkout) &&
                hasSamePricesAndShipping(checkout) &&
                reservationsMatch(checkout) &&
                checkout.orders.length > 0 &&
                checkout.orders.every((order) => order.status === "PENDING_PAYMENT")
            )

            if (reusableCheckout) {
                const checkoutSubtotal = reusableCheckout.orders.reduce(
                    (sum, order) => sum.plus(order.subtotal),
                    new Prisma.Decimal(0)
                )
                const checkoutShipping = reusableCheckout.orders.reduce(
                    (sum, order) => sum.plus(order.shippingCost),
                    new Prisma.Decimal(0)
                )

                return {
                    httpStatus: 200,
                    response: {
                        code: "CHECKOUT_REUSED",
                        checkout: {
                            id: reusableCheckout.id,
                            status: reusableCheckout.status,
                            expiresAt: reusableCheckout.expiresAt,
                            delivery: {
                                fullName: reusableCheckout.deliveryName,
                                phone: reusableCheckout.deliveryPhone,
                                address: reusableCheckout.deliveryAddress,
                                state: reusableCheckout.deliveryState,
                                lga: reusableCheckout.deliveryLga,
                                instructions: reusableCheckout.deliveryInstructions
                            }
                        },
                        items: reusableCheckout.checkoutItems.map((item) => ({
                            listingId: item.listingId,
                            title: item.title,
                            unitPrice: formatMoney(item.unitPrice),
                            quantity: item.quantity
                        })),
                        subtotal: formatMoney(checkoutSubtotal),
                        shipping: formatMoney(checkoutShipping),
                        total: formatMoney(reusableCheckout.total),
                        orders: reusableCheckout.orders.map((order) => ({
                            id: order.id,
                            seller: order.seller.sellerProfile
                                ? {
                                    businessName: order.seller.sellerProfile.businessName,
                                    slug: order.seller.sellerProfile.slug
                                }
                                : null,
                            status: order.status,
                            subtotal: formatMoney(order.subtotal),
                            shipping: formatMoney(order.shippingCost),
                            total: formatMoney(order.total),
                            items: order.orderItems.map((item) => ({
                                listingId: item.listingId,
                                title: item.title,
                                unitPrice: formatMoney(item.unitPrice),
                                quantity: item.quantity
                            }))
                        }))
                    }
                }
            }

            if (existingCheckouts.some((checkout) => !deliveryMatchesCheckout(delivery, checkout))) {
                throw new CheckoutCreationError(
                    409,
                    "Delivery details differ from an existing checkout",
                    "CHECKOUT_CONFLICT"
                )
            }

            const hasUnsafeHistory = existingCheckouts.some((checkout) =>
                checkout.status !== "PENDING" ||
                checkout.paymentAttempts.length > 0 ||
                checkout.orders.length === 0 ||
                checkout.orders.some((order) => order.status !== "PENDING_PAYMENT")
            )

            if (hasUnsafeHistory) {
                throw new CheckoutCreationError(
                    409,
                    "An existing checkout has payment activity and cannot be replaced",
                    "CHECKOUT_CONFLICT"
                )
            }

            for (const checkout of existingCheckouts) {
                const transitioned = await tx.checkout.updateMany({
                    where: {
                        id: checkout.id,
                        userId,
                        status: "PENDING",
                        expiresAt: { gt: now }
                    },
                    data: { status: "EXPIRED" }
                })

                if (transitioned.count !== 1) {
                    throw new CheckoutCreationError(
                        409,
                        "Checkout state changed before replacement could complete",
                        "CHECKOUT_CONFLICT"
                    )
                }

                await tx.inventoryReservation.updateMany({
                    where: {
                        checkoutId: checkout.id,
                        status: "ACTIVE"
                    },
                    data: { status: "RELEASED" }
                })

                await tx.order.updateMany({
                    where: {
                        checkoutId: checkout.id,
                        status: "PENDING_PAYMENT"
                    },
                    data: { status: "CANCELLED" }
                })
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
                    sellerId: seller.sellerId,
                    seller: seller.seller,
                    status: "PENDING_PAYMENT" as const,
                    subtotal: formatMoney(seller.subtotal),
                    shipping: formatMoney(seller.shipping),
                    total: formatMoney(orderTotal)
                })
            }

            return {
                httpStatus: 201,
                response: {
                    code: replaceableCheckoutIds.length > 0 ? "CHECKOUT_REPLACED" : "CHECKOUT_CREATED",
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
                    items: cart.cartItems.map(({ listingId, quantity, listing }) => ({
                        listingId,
                        title: listing.title,
                        unitPrice: formatMoney(
                            new Prisma.Decimal(listing.price.toString()).toDecimalPlaces(2)
                        ),
                        quantity
                    })),
                    subtotal: formatMoney(subtotal),
                    shipping: formatMoney(shipping),
                    total: formatMoney(total),
                    orders: createdOrders.map(({ sellerId, ...order }) => ({
                        ...order,
                        items: cart.cartItems
                            .filter(({ listing }) => listing.user.id === sellerId)
                            .map(({ listingId, quantity, listing }) => ({
                                listingId,
                                title: listing.title,
                                unitPrice: formatMoney(
                                    new Prisma.Decimal(listing.price.toString()).toDecimalPlaces(2)
                                ),
                                quantity
                            }))
                    }))
                }
            }
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        })

        res.status(result.httpStatus).send(result.response)
    } catch (error) {
        if (error instanceof CheckoutCreationError) {
            res.status(error.statusCode).send({
                message: error.message,
                ...(error.code ? { code: error.code } : {}),
                ...(error.review ? { review: error.review } : {})
            })
            return
        }

        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
            res.status(409).send({
                code: "CHECKOUT_CONFLICT",
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

        const now = new Date()
        const existingCheckoutIds = await prisma.checkout.findMany({
            where: {
                userId,
                status: { in: ["PENDING", "PAYMENT_PENDING"] },
                expiresAt: { gt: now }
            },
            select: { id: true }
        })
        const listingIds = [...new Set(cart.cartItems.map(({ listingId }) => listingId))]
        const activeReservations = await prisma.inventoryReservation.findMany({
            where: {
                listingId: { in: listingIds },
                status: "ACTIVE",
                expiresAt: { gt: now },
                ...(existingCheckoutIds.length > 0
                    ? { checkoutId: { notIn: existingCheckoutIds.map(({ id }) => id) } }
                    : {})
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

        res.send(buildCheckoutReview(userId, Array.from(sellers.values())))
    } catch (error) {
        console.error(error)

        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
            res.status(409).send({
                code: "CHECKOUT_CONFLICT",
                message: "Checkout state changed while loading your cart. Please try again."
            })
            return
        }

        res.status(500).send({
            message: "Sorry, there is an issue on our end"
        })
    }
}
