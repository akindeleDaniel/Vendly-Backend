import "dotenv/config"
import cors from "cors"
import express from "express"
import listingRoutes from "./routes/listingRoutes.js"
import userRoutes from "./routes/userRoutes.js"
import cookieParser from "cookie-parser"
import sellerRoutes from "./routes/sellerRoutes.js"

const app = express()

app.use(cors({
    origin: "http://localhost:5173",
    credentials:true
}))
app.use(express.json())
app.use(cookieParser())
app.use("/users", userRoutes)
app.use("/listings", listingRoutes)
app.use("/seller", sellerRoutes)

app.listen(3000, () => {
    console.log("Server is running on port 3000")
})