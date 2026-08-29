import express from "express"
import listingRoutes from "./routes/listingRoutes.js"

const app = express()

app.use("/listings", listingRoutes)

app.listen(3000, () => {
    console.log("Server is running on port 3000")
})