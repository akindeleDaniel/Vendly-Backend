import { Router } from "express"
import {addToCart, getCart, updateCartItem, removeCartItem} from "../controllers/cartController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.get("/", authMiddleware, requireRole("CONSUMER"), getCart)
router.post("/items", authMiddleware, requireRole("CONSUMER"), addToCart)
router.patch("/items/:listingId", authMiddleware, requireRole("CONSUMER"), updateCartItem)
router.delete("/items/:listingId", authMiddleware, requireRole("CONSUMER"), removeCartItem)

export default router