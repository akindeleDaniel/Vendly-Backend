import { Router } from "express"
import { createCheckout, getCheckoutPreview } from "../controllers/checkoutController.js"
import { createCheckoutPayment } from "../controllers/paymentController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireBuyer } from "../middleware/requireRole.js"
import { paymentStartLimiter } from "../middleware/rateLimits.js"

const router = Router()

router.post("/", authMiddleware, requireBuyer, paymentStartLimiter, createCheckout)
router.get("/preview", authMiddleware, requireBuyer, getCheckoutPreview)
router.post("/:id/payments", authMiddleware, requireBuyer, paymentStartLimiter, createCheckoutPayment)

export default router
