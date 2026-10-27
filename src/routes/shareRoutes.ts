import { Router } from "express"
import { shareProduct, shareShop } from "../controllers/shareController.js"

// Public pages for link previews (WhatsApp, Facebook, X, Telegram). Each sends people on to the app.
const router = Router()

router.get("/shop/:slug", shareShop)
router.get("/product/:id", shareProduct)

export default router
