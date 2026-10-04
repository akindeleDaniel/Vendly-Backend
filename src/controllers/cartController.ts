import type { Request, Response } from "express";
import prisma from "../lib/prisma.js";

const cartItemListingSelect = {
    id: true,
    title: true,
    description: true,
    price: true,
    stockQuantity: true,
    category: true,
    imageUrl: true,
    user: {
        select: {
            sellerProfile: {
                select: {
                    businessName: true,
                    slug: true
                }
            }
        }
    }
} as const;



export async function getCart(req: Request, res: Response) {
    const userId = req.user?.id;

    if (!userId) {
        res.status(401).send({ message: "Authentication required" });
        return;
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
                            select: cartItemListingSelect
                        }
                    }
                }
            }
        });

        res.send({ cart });
    } catch (error) {
        console.error(error);
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
        res.status(400).send({ message: "Quantity must be at least 1" });
        return;
    }

    try {
        const listing = await prisma.listing.findUnique({
            where: { id: listingId }
        });

        if (!listing) {
            res.status(404).send({ message: "This Listing was not found" });
            return;
        }

        if (listing.stockQuantity === 0) {
            res.status(409).send({ message: "This listing has been sold out" });
            return;
        }
        
        if (quantity > listing.stockQuantity) {
            res.status(409).send({
                message: `Only ${listing.stockQuantity} units currently available`
            });
            return;
        }

        let cart = await prisma.cart.findUnique({
            where: { userId: id }
        });

        if (!cart) {
            cart = await prisma.cart.create({
                data: {
                    userId: id
                }
            });
        }

        const cartItem = await prisma.cartItem.findUnique({
            where: {
                cartId_listingId: {
                    cartId: cart.id,
                    listingId: listingId
                }
            }
        });

        if (cartItem) {
            const newQuantity = cartItem.quantity + quantity;

            if (newQuantity > listing.stockQuantity) {
                res.status(409).send({
                    message: `Only ${listing.stockQuantity} units currently available`
                });
                return;
            }

            const updatedCartItem = await prisma.cartItem.update({
                where: {
                    id: cartItem.id
                },
                data: {
                    quantity: newQuantity
                }
            });

            res.status(200).send(updatedCartItem);
            return;
        }

        const newCartItem = await prisma.cartItem.create({
            data: {
                cartId: cart.id,
                listingId: listingId,
                quantity: quantity
            }
        });

        res.status(201).send(newCartItem);
        return;

    } catch (error) {
        console.error(error);
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
        const cart = await prisma.cart.findUnique({
            where: { userId },
            select: { id: true }
        });

        if (!cart) {
            res.status(404).send({ message: "Cart not found" });
            return;
        }

        const cartItem = await prisma.cartItem.findUnique({
            where: {
                cartId_listingId: {
                    cartId: cart.id,
                    listingId
                }
            },
            select: {
                listing: {
                    select: {
                        stockQuantity: true
                    }
                }
            }
        });

        if (!cartItem) {
            res.status(404).send({ message: "Cart item not found" });
            return;
        }

        if (quantity > cartItem.listing.stockQuantity) {
            res.status(409).send({
                message: `Only ${cartItem.listing.stockQuantity} units currently available`
            });
            return;
        }

        const updatedCartItem = await prisma.cartItem.update({
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

        res.send(updatedCartItem);
    } catch (error) {
        console.error(error);
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
export default addToCart