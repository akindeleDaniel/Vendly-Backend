import cors from "cors"
import express from "express"
import listingRoutes from "./routes/listingRoutes.js"
import userRoutes from "./routes/userRoutes.js"
import cookieParser from "cookie-parser"
import sellerRoutes from "./routes/sellerRoutes.js"
import cartRoutes from "./routes/cartRoutes.js"
import checkoutRoutes from "./routes/checkoutRoutes.js"
import paymentRoutes from "./routes/paymentRoutes.js"
import orderRoutes from "./routes/orderRoutes.js"
import adminRoutes from "./routes/adminRoutes.js"
import disputeRoutes from "./routes/disputeRoutes.js"
import reviewRoutes from "./routes/reviewRoutes.js"
import preOrderRoutes from "./routes/preOrderRoutes.js"
import webhookRoutes from "./routes/webhookRoutes.js"
import { ensureRequestBody, errorHandler, notFoundHandler } from "./middleware/errorHandlers.js"
import config from "./config.js"
import helmet from "helmet"
import healthRoutes from "./routes/healthRoutes.js"
import { generalLimiter } from "./middleware/rateLimits.js"
import { requireTrustedOrigin } from "./middleware/sameOrigin.js"
import shareRoutes from "./routes/shareRoutes.js"
import { sitemap } from "./controllers/shareController.js"
import emailRoutes from "./routes/emailRoutes.js"

const app = express()

app.set("trust proxy", config.trustProxy)
// Security headers (no sniffing, no framing, no referrer leaks, and the X-Powered-By banner removed). This is
// a JSON API read by a page on another origin, so its responses must be readable cross-origin.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }))
app.use("/health", healthRoutes)
app.use(cors({
    origin: config.frontendUrl,
    credentials:true
}))
// Mounted before the JSON parser: webhooks need the raw request body to check signatures.
app.use("/payments/webhooks", webhookRoutes)
app.use(generalLimiter)
// The "stop these emails" links in emails. They need no login (the link itself is signed) and their pages post to
// themselves, so they are mounted before the check below, which only lets the frontend's own pages make changes.
app.use("/email", emailRoutes)
// Refuses changes asked for by another website using a visitor's cookies.
app.use(requireTrustedOrigin)
// Spreadsheet imports send a whole file (a Shopify export can be a few megabytes); everything else stays small.
const importBodyParser = express.json({ limit: "3mb" })
const bodyParser = express.json()
app.use((req, res, next) => (req.method === "POST" && req.path === "/listings/import" ? importBodyParser : bodyParser)(req, res, next))
app.use(ensureRequestBody)
app.use(cookieParser())
app.use("/users", userRoutes)
app.use("/listings", listingRoutes)
app.use("/seller", sellerRoutes)
app.use("/cart", cartRoutes)
app.use("/checkout", checkoutRoutes)
app.use("/payments", paymentRoutes)
app.use("/orders", orderRoutes)
app.use("/admin", adminRoutes)
app.use("/disputes", disputeRoutes)
app.use("/reviews", reviewRoutes)
app.use("/pre-orders", preOrderRoutes)
// Link-preview pages for shared shop and product links, and the sitemap for search engines.
app.use("/share", shareRoutes)
app.get("/sitemap.xml", sitemap)
app.use(notFoundHandler)
app.use(errorHandler)

export default app
