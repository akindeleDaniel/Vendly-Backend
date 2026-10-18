import cors from "cors"
import express from "express"
import listingRoutes from "./routes/listingRoutes.js"
import userRoutes from "./routes/userRoutes.js"
import cookieParser from "cookie-parser"
import sellerRoutes from "./routes/sellerRoutes.js"
import cartRoutes from "./routes/cartRoutes.js"
import checkoutRoutes from "./routes/checkoutRoutes.js"
import { ensureRequestBody, errorHandler, notFoundHandler } from "./middleware/errorHandlers.js"

const app = express()

app.use(cors({
    origin: "http://localhost:5173",
    credentials:true
}))
app.use(express.json())
app.use(ensureRequestBody)
app.use(cookieParser())
app.use("/users", userRoutes)
app.use("/listings", listingRoutes)
app.use("/seller", sellerRoutes)
app.use("/cart", cartRoutes)
app.use("/checkout", checkoutRoutes)
app.use(notFoundHandler)
app.use(errorHandler)

export default app
