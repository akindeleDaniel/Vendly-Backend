import { Router } from "express"
import { changeMyReview, removeMyReview } from "../controllers/reviewController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { reviewLimiter } from "../middleware/rateLimits.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

// A buyer's own reviews. Writing one is under /orders/:id/seller-orders/:orderId/reviews; reading them is public.
// :kind is "products" or "shops".
router.patch("/:kind/:reviewId", authMiddleware, requireRole("CONSUMER"), reviewLimiter, changeMyReview)
router.delete("/:kind/:reviewId", authMiddleware, requireRole("CONSUMER"), reviewLimiter, removeMyReview)

export default router
