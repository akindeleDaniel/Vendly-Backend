import { Router } from "express"
import { appealMyDispute, countBuyerUnreadDisputes, getMyDispute, listMyDisputes, postBuyerMessage, withdrawMyDispute } from "../controllers/disputeController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { messageLimiter } from "../middleware/rateLimits.js"
import { requireBuyer } from "../middleware/requireRole.js"

const router = Router()

// A buyer's complaints. Opening one is under /orders/:id/seller-orders/:orderId/disputes.
router.get("/", authMiddleware, requireBuyer, listMyDisputes)
// Must come before "/:id", which would otherwise treat "unread" as a complaint id.
router.get("/unread", authMiddleware, requireBuyer, countBuyerUnreadDisputes)
router.get("/:id", authMiddleware, requireBuyer, getMyDispute)
router.post("/:id/messages", authMiddleware, requireBuyer, messageLimiter, postBuyerMessage)
router.post("/:id/appeal", authMiddleware, requireBuyer, messageLimiter, appealMyDispute)
router.post("/:id/withdraw", authMiddleware, requireBuyer, withdrawMyDispute)

export default router
