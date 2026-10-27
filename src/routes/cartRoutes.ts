import { Router } from "express"
import {addToCart, getCart, updateCartItem, removeCartItem, clearCart} from "../controllers/cartController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireBuyer } from "../middleware/requireRole.js"

const router = Router()

router.get("/", authMiddleware, requireBuyer, getCart)
router.post("/items", authMiddleware, requireBuyer, addToCart)
router.patch("/items/:listingId", authMiddleware, requireBuyer, updateCartItem)
router.delete("/items/:listingId", authMiddleware, requireBuyer, removeCartItem)
router.delete("/", authMiddleware, requireBuyer, clearCart)

export default router