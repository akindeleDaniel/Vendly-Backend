import { Router } from "express"
import { getMyDispute, listMyDisputes, postBuyerMessage, withdrawMyDispute } from "../controllers/disputeController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

// A buyer's complaints. Opening one is under /orders/:id/seller-orders/:orderId/disputes.
router.get("/", authMiddleware, requireRole("CONSUMER"), listMyDisputes)
router.get("/:id", authMiddleware, requireRole("CONSUMER"), getMyDispute)
router.post("/:id/messages", authMiddleware, requireRole("CONSUMER"), postBuyerMessage)
router.post("/:id/withdraw", authMiddleware, requireRole("CONSUMER"), withdrawMyDispute)

export default router
