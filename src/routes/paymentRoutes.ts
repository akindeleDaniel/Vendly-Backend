import { Router } from "express"
import { getPayment } from "../controllers/paymentController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.get("/:reference", authMiddleware, requireRole("CONSUMER"), getPayment)

export default router
