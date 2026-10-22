import { Router } from "express"
import { appealMyDispute, countBuyerUnreadDisputes, getMyDispute, listMyDisputes, postBuyerMessage, withdrawMyDispute } from "../controllers/disputeController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { messageLimiter } from "../middleware/rateLimits.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

// A buyer's complaints. Opening one is under /orders/:id/seller-orders/:orderId/disputes.
router.get("/", authMiddleware, requireRole("CONSUMER"), listMyDisputes)
// Must come before "/:id", which would otherwise treat "unread" as a complaint id.
router.get("/unread", authMiddleware, requireRole("CONSUMER"), countBuyerUnreadDisputes)
router.get("/:id", authMiddleware, requireRole("CONSUMER"), getMyDispute)
router.post("/:id/messages", authMiddleware, requireRole("CONSUMER"), messageLimiter, postBuyerMessage)
router.post("/:id/appeal", authMiddleware, requireRole("CONSUMER"), messageLimiter, appealMyDispute)
router.post("/:id/withdraw", authMiddleware, requireRole("CONSUMER"), withdrawMyDispute)

export default router
