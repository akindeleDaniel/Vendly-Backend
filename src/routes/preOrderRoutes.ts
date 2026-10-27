import { Router } from "express"
import { askForPreOrder, cancelMyPreOrder, getMyPreOrder, listMyPreOrders } from "../controllers/preOrderController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { preOrderLimiter } from "../middleware/rateLimits.js"
import { requireBuyer } from "../middleware/requireRole.js"

const router = Router()

// A buyer's requests to food shops. The seller's side is under /seller/pre-orders.
router.post("/", authMiddleware, requireBuyer, preOrderLimiter, askForPreOrder)
router.get("/", authMiddleware, requireBuyer, listMyPreOrders)
router.get("/:id", authMiddleware, requireBuyer, getMyPreOrder)
router.post("/:id/cancel", authMiddleware, requireBuyer, cancelMyPreOrder)

export default router
