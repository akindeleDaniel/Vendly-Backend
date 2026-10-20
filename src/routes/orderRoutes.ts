import { Router } from "express"
import { confirmOrderDelivery, countOrdersAwaitingConfirmation, getMyOrder, listMyOrders } from "../controllers/orderController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.get("/", authMiddleware, requireRole("CONSUMER"), listMyOrders)
// Must come before "/:id", which would otherwise treat "awaiting-confirmation" as an order ID.
router.get("/awaiting-confirmation", authMiddleware, requireRole("CONSUMER"), countOrdersAwaitingConfirmation)
router.get("/:id", authMiddleware, requireRole("CONSUMER"), getMyOrder)
router.post("/:id/seller-orders/:orderId/confirm-delivery", authMiddleware, requireRole("CONSUMER"), confirmOrderDelivery)

export default router
