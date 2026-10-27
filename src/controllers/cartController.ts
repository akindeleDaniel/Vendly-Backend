import type { Request, Response } from "express";
import prisma from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import { heldReservationConditions } from "../lib/inventoryReservations.js";
import { brandColorFor } from "../lib/shopBranding.js";

const cartItemListingSelect = {
    id: true,
    title: true,
    description: true,
    price: true,
    stockQuantity: true,
    category: true,
    imageUrl: true,
    // A chosen option of a product: which option and size the shopper picked.
    parentId: true,
    optionLabel: true,
    sizeLabel: true,
    parent: {
        select: {
            title: true
        }
    },
    user: {
        select: {
            sellerProfile: {
                select: {
                    businessName: true,
                    slug: true,
                    logoUrl: true,
                    location: true,
                    brandColor: true
                }
            }
        }
    }
} as const;

type CartItemListing = Prisma.ListingGetPayload<{ select: typeof cartItemListingSelect }>;

// The listing as the cart shows it. A chosen option's own title reads "Product — Blue / M", so productTitle carries
// the product's plain name, and the shop's colour is sent as the resolved preset, as on the shop page.
function cartListingView({ parent, user, ...listing }: CartItemListing) {
    const shop = user.sellerProfile;

    return {
        ...listing,
        productTitle: parent?.title ?? listing.title,
        user: {
            sellerProfile: shop ? { ...shop, brandColor: brandColorFor(shop.brandColor) } : null
        }
    };
}

class CartRequestError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
        readonly code?: "CART_OWN_LISTING"
    ) {
        super(message);
    }
}

function sendCartRequestError(error: CartRequestError, res: Response): void {
    res.status(error.statusCode).send({ message: error.message, ...(error.code ? { code: error.code } : {}) });
}

async function getOtherReservedQuantities(
    tx: Prisma.TransactionClient,
    userId: number,
    listingIds: number[],
    now: Date
): Promise<Map<number, number>> {
    const reservations = await tx.inventoryReservation.findMany({
        where: {
            listingId: { in: listingIds },
            OR: heldReservationConditions(now, {
                checkout: {
                    userId: { not: userId }
                }
            })
        },
        select: {
            listingId: true,
            quantity: true
        }
    });
    const reservedQuantities = new Map<number, number>();

    for (const reservation of reservations) {
        reservedQuantities.set(
            reservation.listingId,
            (reservedQuantities.get(reservation.listingId) ?? 0) + reservation.quantity
        );
    }

    return reservedQuantities;
}

function availableQuantity(stockQuantity: number, reservedQuantity: number): number {
    return Math.max(stockQuantity - reservedQuantity, 0);
}

function sendCartConflict(error: unknown, res: Response): boolean {
    if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2025", "P2034"].includes(error.code)
    ) {
        res.status(409).send({
            message: "Cart or inventory changed. Please try again."
        });
        return true;
    }

    return false;
}



export async function getCart(req: Request, res: Response) {
    const userId = req.user?.id;

    if (!userId) {
        res.status(401).send({ message: "Authentication required" });
        return;
    }

    try {
        const cart = await prisma.$transaction(async (tx) => {
            const currentCart = await tx.cart.findUnique({
                where: { userId },
                select: {
                    cartItems: {
                        select: {
                            listingId: true,
                            quantity: true,
                            listing: {
                                select: cartItemListingSelect
                            }
                        }
                    }
                }
            });

            if (!currentCart) {
                return null;
            }

            const now = new Date();
            const reservedQuantities = await getOtherReservedQuantities(
                tx,
                userId,
                currentCart.cartItems.map(({ listingId }) => listingId),
                now
            );

            return {
                ...currentCart,
                cartItems: currentCart.cartItems.map((item) => ({
                    ...item,
                    listing: cartListingView(item.listing),
                    availableQuantity: availableQuantity(
                        item.listing.stockQuantity,
                        reservedQuantities.get(item.listingId) ?? 0
                    )
                }))
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        });

        res.send({ cart });
    } catch (error) {
        console.error(error);
        if (sendCartConflict(error, res)) {
            return;
        }
        res.status(500).send({
            message: "Sorry, there is an issue on our end"
        });
    }
}



export async function addToCart(req: Request, res: Response) {
    const { listingId, quantity } = req.body;
    const id = req.user?.id;

    if (!id) {
        res.status(401).send({ message: "Authentication required" });
        return;
    }

    if (!Number.isInteger(listingId) || listingId < 1) {
        res.status(400).send({ message: "Invalid listing ID" });
        return;
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
        res.status(400).send({
            message: "Quantity must be at least 1"
        });
        return;
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            const listing = await tx.listing.findUnique({
                where: { id: listingId },
                select: {
                    userId: true,
                    stockQuantity: true,
                    archivedAt: true,
                    user: { select: { sellerProfile: { select: { blockedAt: true } } } },
                    options: { where: { archivedAt: null }, select: { id: true }, take: 1 }
                }
            });

            // A listing the seller took off sale, or one from a blocked shop, cannot be bought.
            if (!listing || listing.archivedAt || listing.user.sellerProfile?.blockedAt) {
                throw new CartRequestError(404, "This Listing was not found");
            }

            // A seller can shop like anyone else, but never from their own shop.
            if (listing.userId === id) {
                throw new CartRequestError(409, "You cannot buy from your own shop", "CART_OWN_LISTING");
            }

            // A product with options is bought through one of its options, never itself.
            if (listing.options.length > 0) {
                throw new CartRequestError(409, "Choose an option for this product");
            }

            // Buyers get a cart when they register; a seller gets one the first time they add something.
            const cart = await tx.cart.upsert({
                where: { userId: id },
                create: { userId: id },
                update: {}
            });

            const cartItem = await tx.cartItem.findUnique({
                where: {
                    cartId_listingId: {
                        cartId: cart.id,
                        listingId
                    }
                }
            });
            const reservedQuantities = await getOtherReservedQuantities(
                tx,
                id,
                [listingId],
                new Date()
            );
            const available = availableQuantity(
                listing.stockQuantity,
                reservedQuantities.get(listingId) ?? 0
            );
            const newQuantity = (cartItem?.quantity ?? 0) + quantity;

            if (newQuantity > available) {
                throw new CartRequestError(
                    409,
                    `Only ${available} units currently available`
                );
            }

            // A change allows one more reminder later, about a day after the last change.
            await tx.cart.update({ where: { id: cart.id }, data: { itemsChangedAt: new Date(), reminderSentAt: null } });

            const created = cartItem === null;
            const updatedCartItem = cartItem
                ? await tx.cartItem.update({
                    where: { id: cartItem.id },
                    data: { quantity: newQuantity }
                })
                : await tx.cartItem.create({
                    data: {
                        cartId: cart.id,
                        listingId,
                        quantity
                    }
                });

            return {
                ...updatedCartItem,
                availableQuantity: available,
                created
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        });

        const { created, ...cartItem } = result;
        res.status(created ? 201 : 200).send(cartItem);

    } catch (error) {
        if (error instanceof CartRequestError) {
            sendCartRequestError(error, res);
            return;
        }

        console.error(error);
        if (sendCartConflict(error, res)) {
            return;
        }
        res.status(500).send({
            message: "Sorry, there is an issue on our end"
        });
    }
}



export async function updateCartItem(req: Request, res: Response) {
    const userId = req.user?.id;
    const listingId = Number(req.params.listingId);
    const quantity = req.body?.quantity;

    if (!userId) {
        res.status(401).send({ message: "Authentication required" });
        return;
    }

    if (!Number.isSafeInteger(listingId) || listingId < 1) {
        res.status(400).send({ message: "Invalid listing ID" });
        return;
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
        res.status(400).send({ message: "Quantity must be at least 1" });
        return;
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            const cart = await tx.cart.findUnique({
                where: { userId },
                select: { id: true }
            });

            if (!cart) {
                throw new CartRequestError(404, "Cart not found");
            }

            const cartItem = await tx.cartItem.findUnique({
                where: {
                    cartId_listingId: {
                        cartId: cart.id,
                        listingId
                    }
                },
                select: {
                    listingId: true,
                    quantity: true,
                    listing: {
                        select: cartItemListingSelect
                    }
                }
            });

            if (!cartItem) {
                throw new CartRequestError(404, "Cart item not found");
            }

            const reservedQuantities = await getOtherReservedQuantities(
                tx,
                userId,
                [listingId],
                new Date()
            );
            const available = availableQuantity(
                cartItem.listing.stockQuantity,
                reservedQuantities.get(listingId) ?? 0
            );

            if (quantity > available) {
                throw new CartRequestError(
                    409,
                    `Only ${available} units currently available`
                );
            }

            await tx.cart.update({ where: { id: cart.id }, data: { itemsChangedAt: new Date(), reminderSentAt: null } });

            const updatedCartItem = await tx.cartItem.update({
                where: {
                    cartId_listingId: {
                        cartId: cart.id,
                        listingId
                    }
                },
                data: { quantity },
                select: {
                    listingId: true,
                    quantity: true,
                    listing: {
                        select: cartItemListingSelect
                    }
                }
            });

            return {
                ...updatedCartItem,
                listing: cartListingView(updatedCartItem.listing),
                availableQuantity: available
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        });

        res.send(result);
    } catch (error) {
        if (error instanceof CartRequestError) {
            sendCartRequestError(error, res);
            return;
        }

        console.error(error);
        if (sendCartConflict(error, res)) {
            return;
        }
        res.status(500).send({
            message: "Sorry, there is an issue on our end"
        });
    }
}



export async function removeCartItem(req: Request, res: Response) {
    const userId = req.user?.id;
    const listingId = Number(req.params.listingId);

    if (!userId) {
        res.status(401).send({ message: "Authentication required" });
        return;
    }

    if (!Number.isSafeInteger(listingId) || listingId < 1) {
        res.status(400).send({ message: "Invalid listing ID" });
        return;
    }

    try {
        const cart = await prisma.cart.findUnique({
            where: { userId },
            select: { id: true }
        });

        if (!cart) {
            res.status(404).send({ message: "Cart not found" });
            return;
        }

        const result = await prisma.cartItem.deleteMany({
            where: {
                cartId: cart.id,
                listingId
            }
        });

        if (result.count === 0) {
            res.status(404).send({ message: "Cart item not found" });
            return;
        }

        res.send({ message: "Cart item removed successfully" });
    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: "Sorry, there is an issue on our end"
        });
    }
}



export async function clearCart(req: Request, res: Response) {
    const userId = req.user?.id;

    if (!userId) {
        res.status(401).send({ message: "Authentication required" });
        return;
    }

    try {
        const cart = await prisma.cart.findUnique({
            where: { userId },
            select: { id: true }
        });

        if (cart) {
            await prisma.cartItem.deleteMany({
                where: { cartId: cart.id }
            });
        }

        res.send({ message: "Cart cleared successfully" });
    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: "Sorry, there is an issue on our end"
        });
    }
}

export default addToCart