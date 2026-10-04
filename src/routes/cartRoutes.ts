import { Router } from "express"
import addToCart from "../controllers/cartController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.post("/items", authMiddleware, requireRole("CONSUMER"), addToCart)

export default router