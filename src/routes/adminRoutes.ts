import { Router } from "express"
import {
    getRefund,
    issueOrderRefund,
    listLiabilities,
    listRecoveryCases,
    listRefunds,
    recordManualRecovery,
    refundRecoveryCase,
    resolveRecoveryCase,
    syncRefundNow,
    writeOffLiability
} from "../controllers/adminController.js"
import {
    approveDispute,
    getAdminDispute,
    listAdminDisputes,
    postAdminDisputeMessage,
    rejectAdminDispute,
    reopenAdminDispute
} from "../controllers/adminDisputeController.js"
import { getAdminOrder, getAdminSummary, getAdminUser, listAdminOrders, listAdminUsers } from "../controllers/adminLookupController.js"
import { getAdminSellerStanding, setSellerBlocked } from "../controllers/sellerStandingController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireAdmin } from "../middleware/requireAdmin.js"
import { listAdminReviews, setReviewHidden } from "../controllers/reviewController.js"
import { messageLimiter } from "../middleware/rateLimits.js"

const router = Router()

// Every admin route needs a logged-in administrator.
router.use(authMiddleware, requireAdmin)

router.get("/summary", getAdminSummary)
router.get("/orders", listAdminOrders)
router.get("/orders/:id", getAdminOrder)
router.get("/users", listAdminUsers)
router.get("/users/:id", getAdminUser)
router.get("/sellers/:userId/standing", getAdminSellerStanding)
router.post("/sellers/:userId/block", setSellerBlocked(true))
router.post("/sellers/:userId/unblock", setSellerBlocked(false))
router.post("/orders/:id/refunds", issueOrderRefund)
router.get("/refunds", listRefunds)
router.get("/refunds/:id", getRefund)
router.post("/refunds/:id/sync", syncRefundNow)
router.get("/recovery-cases", listRecoveryCases)
router.post("/recovery-cases/:id/refund", refundRecoveryCase)
router.post("/recovery-cases/:id/resolve", resolveRecoveryCase)
router.get("/liabilities", listLiabilities)
router.post("/liabilities/:id/manual-recovery", recordManualRecovery)
router.post("/liabilities/:id/write-off", writeOffLiability)
router.get("/reviews", listAdminReviews)
router.post("/reviews/:kind/:reviewId/hide", setReviewHidden(true))
router.post("/reviews/:kind/:reviewId/show", setReviewHidden(false))
router.get("/disputes", listAdminDisputes)
router.get("/disputes/:id", getAdminDispute)
router.post("/disputes/:id/messages", messageLimiter, postAdminDisputeMessage)
router.post("/disputes/:id/approve", approveDispute)
router.post("/disputes/:id/reject", rejectAdminDispute)
router.post("/disputes/:id/reopen", reopenAdminDispute)

export default router
