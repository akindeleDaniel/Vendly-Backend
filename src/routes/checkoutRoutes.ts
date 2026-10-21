import { Router } from "express"
import { createCheckout, getCheckoutPreview } from "../controllers/checkoutController.js"
import { createCheckoutPayment } from "../controllers/paymentController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireRole } from "../middleware/requireRole.js"
import { paymentStartLimiter } from "../middleware/rateLimits.js"

const router = Router()

router.post("/", authMiddleware, requireRole("CONSUMER"), paymentStartLimiter, createCheckout)
router.get("/preview", authMiddleware, requireRole("CONSUMER"), getCheckoutPreview)
router.post("/:id/payments", authMiddleware, requireRole("CONSUMER"), paymentStartLimiter, createCheckoutPayment)

export default router
