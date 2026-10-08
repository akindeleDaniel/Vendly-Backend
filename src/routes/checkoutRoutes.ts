import { Router } from "express"
import { createCheckout, getCheckoutPreview } from "../controllers/checkoutController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.post("/", authMiddleware, requireRole("CONSUMER"), createCheckout)
router.get("/preview", authMiddleware, requireRole("CONSUMER"), getCheckoutPreview)

export default router
