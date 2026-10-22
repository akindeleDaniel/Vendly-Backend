import type { Request, Response } from "express"
import { createHash } from "node:crypto"
import prisma from "../lib/prisma.js"
import { Prisma } from "../generated/prisma/client.js"
import { buildLocation } from "../lib/nigeriaLocation.js"
import { heldReservationConditions } from "../lib/inventoryReservations.js"
import { snapshotMatches } from "../lib/preOrders.js"

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
                    shippingCost: true,
                    foodOrderType: true,
                    blockedAt: true
                }
            }
        }
    }
} as const

const checkoutCartItemSelect = {
    listingId: true,
    quantity: true,
    listing: {
        select: checkoutListingSelect
    }
} as const

type CheckoutCartItem = Prisma.CartItemGetPayload<{ select: typeof checkoutCartItemSelect }>

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
    foodOrderType: "NOW" | "PRE_ORDER" | "BOTH"
    items: PreviewItem[]
    subtotal: Prisma.Decimal
    shipping: Prisma.Decimal
}

// A pre-order the seller approved, still payable, for exactly what is in the cart from that seller.
type ApprovedPreOrder = { id: number; readyAt: Date; payBy: Date | null }

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
        // How this shop takes orders, and for a shop that takes pre-orders whether one is needed and whether an
        // approved request exists for what is in the cart. Send the approved request's id in preOrderIds to use it.
        orderType: SellerPreview["foodOrderType"]
        preOrder: { required: boolean; approved: { id: number; readyAt: Date; payBy: Date | null } | null }
        items: PreviewItem[]
        subtotal: string
        shipping: string
        total: string
    }>
    subtotal: string
    shipping: string
    total: string
}

type CheckoutErrorCode =
    | "CHECKOUT_CONFLICT"
    | "CHECKOUT_LOCKED"
    | "CHECKOUT_REVIEW_REQUIRED"
    | "CHECKOUT_ITEMS_UNAVAILABLE"
    | "CHECKOUT_PREORDER_REQUIRED"
    | "CHECKOUT_PREORDER_INVALID"
    | "CHECKOUT_PREORDER_NOT_AVAILABLE"

class CheckoutRequestError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
        readonly code?: CheckoutErrorCode,
        readonly details: Record<string, unknown> = {}
    ) {
        super(message)
    }
}

function sendCheckoutRequestError(error: CheckoutRequestError, res: Response): void {
    res.status(error.statusCode).send({
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...error.details
    })
}

type CheckoutPricing = {
    sellerPreviews: SellerPreview[]
    subtotal: Prisma.Decimal
    shipping: Prisma.Decimal
    total: Prisma.Decimal
}

const maximumCheckoutAmount = new Prisma.Decimal("9999999999.99")

type CheckoutRequest = {
    delivery: DeliveryInput
    reviewToken: string | null
    // Approved pre-order requests to pay for in this checkout, one per food shop at most.
    preOrderIds: number[]
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
    sellers: SellerPreview[],
    approvals: Map<number, ApprovedPreOrder> = new Map()
): CheckoutReview {
    const sortedSellers = [...sellers].sort((left, right) => left.sellerId - right.sellerId)
    const sellerGroups = sortedSellers.map((seller) => {
        const total = seller.subtotal.plus(seller.shipping)

        return {
            seller: seller.seller,
            orderType: seller.foodOrderType,
            preOrder: { required: seller.foodOrderType === "PRE_ORDER", approved: approvals.get(seller.sellerId) ?? null },
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

function priceCheckoutItems(
    cartItems: CheckoutCartItem[],
    reservedQuantities: Map<number, number>
): CheckoutPricing {
    const sellers = new Map<number, SellerPreview>()

    for (const cartItem of cartItems) {
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
            throw new CheckoutRequestError(
                409,
                `Listing ${cartItem.listingId} is unavailable in the requested quantity`,
                "CHECKOUT_ITEMS_UNAVAILABLE",
                { listingId: cartItem.listingId }
            )
        }

        if (!sellerProfile || sellerProfile.blockedAt) {
            throw new CheckoutRequestError(
                409,
                `Listing ${cartItem.listingId} does not have an available seller storefront`,
                "CHECKOUT_ITEMS_UNAVAILABLE",
                { listingId: cartItem.listingId }
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
                throw new CheckoutRequestError(
                    409,
                    `Shipping information is unavailable for ${sellerProfile.businessName}`,
                    "CHECKOUT_ITEMS_UNAVAILABLE",
                    { listingId: cartItem.listingId }
                )
            }

            sellerPreview = {
                sellerId: listing.user.id,
                seller: {
                    businessName: sellerProfile.businessName,
                    slug: sellerProfile.slug
                },
                foodOrderType: sellerProfile.foodOrderType,
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

    if (
        [subtotal, shipping, total, ...sellerPreviews.flatMap((seller) => [seller.subtotal, seller.shipping])]
            .some((amount) => amount.greaterThan(maximumCheckoutAmount))
    ) {
        throw new CheckoutRequestError(
            409,
            "Checkout total exceeds the supported payment amount",
            "CHECKOUT_ITEMS_UNAVAILABLE"
        )
    }

    return { sellerPreviews, subtotal, shipping, total }
}

// The pre-orders the buyer could pay for right now: approved, not lapsed, the time still ahead, and for exactly what
// is in the cart from that seller at today's prices. Keyed by seller.
async function findApprovedPreOrders(
    client: Prisma.TransactionClient | typeof prisma,
    userId: number,
    sellerPreviews: SellerPreview[],
    now: Date
): Promise<Map<number, ApprovedPreOrder>> {
    const candidates = await client.preOrderRequest.findMany({
        where: {
            buyerId: userId,
            sellerId: { in: sellerPreviews.map((seller) => seller.sellerId) },
            status: "APPROVED",
            payBy: { gt: now },
            readyAt: { gt: now }
        },
        orderBy: { id: "desc" }
    })
    const approvals = new Map<number, ApprovedPreOrder>()

    for (const seller of sellerPreviews) {
        const current = seller.items.map((item) => ({ listingId: item.listingId, quantity: item.quantity, unitPrice: item.unitPrice }))
        const match = candidates.find((candidate) => candidate.sellerId === seller.sellerId && snapshotMatches(candidate.items, current))

        if (match) {
            approvals.set(seller.sellerId, { id: match.id, readyAt: match.readyAt, payBy: match.payBy })
        }
    }

    return approvals
}

// Decides which sellers' orders are pre-orders. A shop that only takes pre-orders needs an approved request for the
// cart; a shop that takes both uses one only if the buyer sends its id; any other shop cannot have one.
function choosePreOrders(sellerPreviews: SellerPreview[], approvals: Map<number, ApprovedPreOrder>, requestedIds: number[]): Map<number, ApprovedPreOrder> {
    const chosen = new Map<number, ApprovedPreOrder>()

    for (const id of requestedIds) {
        const entry = [...approvals.entries()].find(([, approval]) => approval.id === id)

        if (!entry) {
            throw new CheckoutRequestError(
                409,
                "That pre-order approval can no longer be used: it has lapsed, or your cart has changed since the seller approved it",
                "CHECKOUT_PREORDER_INVALID",
                { preOrderId: id }
            )
        }

        chosen.set(entry[0], entry[1])
    }

    for (const seller of sellerPreviews) {
        if (seller.foodOrderType === "NOW" && chosen.has(seller.sellerId)) {
            throw new CheckoutRequestError(409, `${seller.seller.businessName} no longer takes pre-orders`, "CHECKOUT_PREORDER_NOT_AVAILABLE", { seller: seller.seller })
        }

        if (seller.foodOrderType === "PRE_ORDER" && !chosen.has(seller.sellerId)) {
            throw new CheckoutRequestError(
                409,
                `${seller.seller.businessName} only takes pre-orders. Ask for a time and wait for the seller to approve it.`,
                "CHECKOUT_PREORDER_REQUIRED",
                { seller: seller.seller }
            )
        }
    }

    return chosen
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

export async function acquireCheckoutCreationLock(tx: Prisma.TransactionClient, userId: number): Promise<void> {
    await tx.$queryRaw`
        WITH lock_acquired AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(1447380556, ${userId}::integer)
        )
        SELECT 1 FROM lock_acquired
    `
}

export async function expireExpiredCheckouts(userId: number, now = new Date()): Promise<void> {
    await prisma.$transaction(async (tx) => {
        const expiredCheckouts = await tx.checkout.findMany({
            where: {
                userId,
                expiresAt: { lte: now },
                OR: [
                    { status: { in: ["PENDING", "PAYMENT_PENDING"] } },
                    {
                        status: "EXPIRED",
                        inventoryReservations: {
                            some: { status: { in: ["ACTIVE", "PROTECTED"] } }
                        }
                    }
                ]
            },
            select: {
                id: true,
                status: true,
                paymentAttempts: { select: { status: true } }
            }
        })

        for (const checkout of expiredCheckouts) {
            if (checkout.status !== "EXPIRED") {
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
            }

            const hasUnresolvedOrSuccessfulPayment = checkout.paymentAttempts.some(
                ({ status }) => status === "PENDING" || status === "SUCCESS"
            )

            await tx.inventoryReservation.updateMany({
                where: {
                    checkoutId: checkout.id,
                    status: { in: ["ACTIVE", "PROTECTED"] }
                },
                data: {
                    status: hasUnresolvedOrSuccessfulPayment ? "PROTECTED" : "EXPIRED"
                }
            })

            if (!hasUnresolvedOrSuccessfulPayment) {
                await tx.order.updateMany({
                    where: {
                        checkoutId: checkout.id,
                        status: "PENDING_PAYMENT"
                    },
                    data: { status: "CANCELLED" }
                })
            }
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
        Object.keys(body).some((field) => field !== "delivery" && field !== "reviewToken" && field !== "preOrderIds") ||
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
            (typeof fields.reviewToken !== "string" || !/^[a-f0-9]{64}$/.test(fields.reviewToken))) ||
        (fields.preOrderIds !== undefined &&
            (!Array.isArray(fields.preOrderIds) ||
                fields.preOrderIds.length > 20 ||
                !fields.preOrderIds.every((id) => Number.isSafeInteger(id) && id > 0)))
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
        reviewToken: typeof fields.reviewToken === "string" ? fields.reviewToken : null,
        preOrderIds: Array.isArray(fields.preOrderIds) ? [...new Set(fields.preOrderIds as number[])] : []
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

    const { delivery, reviewToken, preOrderIds } = checkoutRequest

    try {
        await expireExpiredCheckouts(userId)

        const result = await prisma.$transaction(async (tx) => {
            await acquireCheckoutCreationLock(tx, userId)

            const now = new Date()
            const cart = await tx.cart.findUnique({
                where: { userId },
                select: {
                    cartItems: {
                        select: checkoutCartItemSelect
                    }
                }
            })

            if (!cart || cart.cartItems.length === 0) {
                throw new CheckoutRequestError(400, "Cart is empty")
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
                    OR: heldReservationConditions(
                        now,
                        replaceableCheckoutIds.length > 0
                            ? { checkoutId: { notIn: replaceableCheckoutIds } }
                            : {}
                    )
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

            const { sellerPreviews, subtotal, shipping, total } = priceCheckoutItems(
                cart.cartItems,
                reservedQuantities
            )

            // Food shops that take pre-orders: which of this checkout's orders are pre-orders.
            const approvals = await findApprovedPreOrders(tx, userId, sellerPreviews, now)
            const chosenPreOrders = choosePreOrders(sellerPreviews, approvals, preOrderIds)
            const review = buildCheckoutReview(userId, sellerPreviews, approvals)
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

            const hasPaymentActivity = (checkout: typeof existingCheckouts[number]) =>
                checkout.status !== "PENDING" ||
                checkout.paymentAttempts.length > 0
            const isLocked = (checkout: typeof existingCheckouts[number]) =>
                hasPaymentActivity(checkout) ||
                checkout.orders.length === 0 ||
                checkout.orders.some((order) => order.status !== "PENDING_PAYMENT")

            const hasSamePreOrders = (checkout: typeof existingCheckouts[number]) =>
                checkout.orders.every((order) => (order.preOrderRequestId ?? null) === (chosenPreOrders.get(order.sellerId)?.id ?? null))

            const reusableCheckout = existingCheckouts.find((checkout) =>
                hasSameCart(checkout) &&
                hasSamePreOrders(checkout) &&
                deliveryMatchesCheckout(delivery, checkout) &&
                hasSamePricesAndShipping(checkout) &&
                reservationsMatch(checkout) &&
                checkout.orders.length > 0 &&
                checkout.orders.every((order) => order.status === "PENDING_PAYMENT")
            )
            const lockedCheckout = reusableCheckout ? undefined : existingCheckouts.find(isLocked)

            if (lockedCheckout) {
                throw new CheckoutRequestError(
                    409,
                    hasPaymentActivity(lockedCheckout)
                        ? "An existing checkout has payment activity and cannot be replaced"
                        : "An existing checkout is being processed and cannot be replaced",
                    "CHECKOUT_LOCKED",
                    {
                        checkout: {
                            id: lockedCheckout.id,
                            status: lockedCheckout.status,
                            expiresAt: lockedCheckout.expiresAt
                        }
                    }
                )
            }

            if (reviewToken !== review.reviewToken) {
                throw new CheckoutRequestError(
                    409,
                    "Review the current cart prices and confirm before continuing",
                    "CHECKOUT_REVIEW_REQUIRED",
                    { review }
                )
            }

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
                            fulfilmentType: order.fulfilmentType,
                            readyAt: order.readyAt,
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
                    throw new CheckoutRequestError(
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

            const expiresAt = new Date(Date.now() + (15 * 60 * 1000))
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
                const preOrder = chosenPreOrders.get(seller.sellerId)
                const order = await tx.order.create({
                    data: {
                        checkoutId: checkout.id,
                        sellerId: seller.sellerId,
                        status: "PENDING_PAYMENT",
                        fulfilmentType: preOrder ? "PRE_ORDER" : "NOW",
                        readyAt: preOrder?.readyAt ?? null,
                        preOrderRequestId: preOrder?.id ?? null,
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
                    fulfilmentType: preOrder ? "PRE_ORDER" as const : "NOW" as const,
                    readyAt: preOrder?.readyAt ?? null,
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
        if (error instanceof CheckoutRequestError) {
            sendCheckoutRequestError(error, res)
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
                    select: checkoutCartItemSelect
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
                OR: heldReservationConditions(
                    now,
                    existingCheckoutIds.length > 0
                        ? { checkoutId: { notIn: existingCheckoutIds.map(({ id }) => id) } }
                        : {}
                )
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

        const { sellerPreviews } = priceCheckoutItems(cart.cartItems, reservedQuantities)
        const approvals = await findApprovedPreOrders(prisma, userId, sellerPreviews, now)

        res.send(buildCheckoutReview(userId, sellerPreviews, approvals))
    } catch (error) {
        if (error instanceof CheckoutRequestError) {
            sendCheckoutRequestError(error, res)
            return
        }

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
