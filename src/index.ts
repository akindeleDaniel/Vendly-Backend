import "dotenv/config"
import cors from "cors"
import express from "express"
import listingRoutes from "./routes/listingRoutes.js"
import userRoutes from "./routes/userRoutes.js"

const app = express()

app.use(cors())
app.use(express.json())
app.use("/users", userRoutes)
app.use("/listings", listingRoutes)

app.listen(3000, () => {
    console.log("Server is running on port 3000")
})