import express, { Router } from "express"
import { handlePaymentWebhook } from "../controllers/webhookController.js"

const router = Router()

// Webhook signatures are computed over the exact bytes sent, so these routes read the raw body
// (whatever its content type) instead of the app-wide JSON parser.
router.use(express.raw({ type: () => true, limit: "1mb" }))
router.post("/paystack", handlePaymentWebhook("PAYSTACK"))
router.post("/flutterwave", handlePaymentWebhook("FLUTTERWAVE"))

export default router
