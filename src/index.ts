import "dotenv/config"
import config, { assertRequiredEnvironment } from "./config.js"
import app from "./app.js"

assertRequiredEnvironment(process.env)

app.listen(config.port, () => {
    console.log(`Server is running on port ${config.port}`)
})
