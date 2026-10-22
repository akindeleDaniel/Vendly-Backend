import { Router } from "express"
import { askForPreOrder, cancelMyPreOrder, getMyPreOrder, listMyPreOrders } from "../controllers/preOrderController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { preOrderLimiter } from "../middleware/rateLimits.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

// A buyer's requests to food shops. The seller's side is under /seller/pre-orders.
router.post("/", authMiddleware, requireRole("CONSUMER"), preOrderLimiter, askForPreOrder)
router.get("/", authMiddleware, requireRole("CONSUMER"), listMyPreOrders)
router.get("/:id", authMiddleware, requireRole("CONSUMER"), getMyPreOrder)
router.post("/:id/cancel", authMiddleware, requireRole("CONSUMER"), cancelMyPreOrder)

export default router
