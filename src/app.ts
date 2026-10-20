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
import webhookRoutes from "./routes/webhookRoutes.js"
import { ensureRequestBody, errorHandler, notFoundHandler } from "./middleware/errorHandlers.js"
import config from "./config.js"

const app = express()

app.use(cors({
    origin: config.frontendUrl,
    credentials:true
}))
// Mounted before the JSON parser: webhooks need the raw request body to check signatures.
app.use("/payments/webhooks", webhookRoutes)
app.use(express.json())
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
app.use(notFoundHandler)
app.use(errorHandler)

export default app
