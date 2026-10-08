import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma } from "../generated/prisma/client.js"

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
    seller: {
        businessName: string
        slug: string
    }
    items: PreviewItem[]
    subtotal: Prisma.Decimal
    shipping: Prisma.Decimal
}

function formatMoney(amount: Prisma.Decimal): string {
    return amount.toFixed(2)
}

export async function getCheckoutPreview(req: Request, res: Response) {
    const userId = req.user?.id

    if (!userId) {
        res.status(401).send({ message: "Authentication required" })
        return
    }

    try {
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
        res.status(500).send({
            message: "Sorry, there is an issue on our end"
        })
    }
}
