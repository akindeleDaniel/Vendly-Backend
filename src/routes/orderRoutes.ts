import { Router } from "express"
import { confirmOrderDelivery, countOrdersAwaitingConfirmation, getMyOrder, listMyOrders } from "../controllers/orderController.js"
import { openBuyerDispute } from "../controllers/disputeController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { complaintLimiter, reviewLimiter } from "../middleware/rateLimits.js"
import { createMyOrderReviews, getMyOrderReviews } from "../controllers/reviewController.js"
import { requireBuyer } from "../middleware/requireRole.js"

const router = Router()

router.get("/", authMiddleware, requireBuyer, listMyOrders)
// Must come before "/:id", which would otherwise treat "awaiting-confirmation" as an order ID.
router.get("/awaiting-confirmation", authMiddleware, requireBuyer, countOrdersAwaitingConfirmation)
router.get("/:id", authMiddleware, requireBuyer, getMyOrder)
router.post("/:id/seller-orders/:orderId/confirm-delivery", authMiddleware, requireBuyer, confirmOrderDelivery)
router.get("/:id/seller-orders/:orderId/reviews", authMiddleware, requireBuyer, getMyOrderReviews)
router.post("/:id/seller-orders/:orderId/reviews", authMiddleware, requireBuyer, reviewLimiter, createMyOrderReviews)
router.post("/:id/seller-orders/:orderId/disputes", authMiddleware, requireBuyer, complaintLimiter, openBuyerDispute)

export default router
