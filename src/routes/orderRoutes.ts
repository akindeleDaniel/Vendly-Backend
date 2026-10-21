import { Router } from "express"
import { confirmOrderDelivery, countOrdersAwaitingConfirmation, getMyOrder, listMyOrders } from "../controllers/orderController.js"
import { openBuyerDispute } from "../controllers/disputeController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { complaintLimiter } from "../middleware/rateLimits.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.get("/", authMiddleware, requireRole("CONSUMER"), listMyOrders)
// Must come before "/:id", which would otherwise treat "awaiting-confirmation" as an order ID.
router.get("/awaiting-confirmation", authMiddleware, requireRole("CONSUMER"), countOrdersAwaitingConfirmation)
router.get("/:id", authMiddleware, requireRole("CONSUMER"), getMyOrder)
router.post("/:id/seller-orders/:orderId/confirm-delivery", authMiddleware, requireRole("CONSUMER"), confirmOrderDelivery)
router.post("/:id/seller-orders/:orderId/disputes", authMiddleware, requireRole("CONSUMER"), complaintLimiter, openBuyerDispute)

export default router
