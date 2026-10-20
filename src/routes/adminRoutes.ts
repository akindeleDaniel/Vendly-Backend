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
    rejectAdminDispute
} from "../controllers/adminDisputeController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireAdmin } from "../middleware/requireAdmin.js"

const router = Router()

// Every admin route needs a logged-in administrator.
router.use(authMiddleware, requireAdmin)

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
router.get("/disputes", listAdminDisputes)
router.get("/disputes/:id", getAdminDispute)
router.post("/disputes/:id/messages", postAdminDisputeMessage)
router.post("/disputes/:id/approve", approveDispute)
router.post("/disputes/:id/reject", rejectAdminDispute)

export default router
