import { Router } from "express"
import { showStopCartReminders, stopCartReminders } from "../controllers/emailController.js"

// Pages opened from links in emails. No login: each link is signed for the person it was sent to.
const router = Router()

router.get("/cart-reminders/stop", showStopCartReminders)
router.post("/cart-reminders/stop", stopCartReminders)

export default router
