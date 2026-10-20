import "dotenv/config"
import config, { assertRequiredEnvironment } from "./config.js"
import { assertEmailEnvironment } from "./lib/email/config.js"
import app from "./app.js"
import { startPaymentChecker } from "./lib/payments/paymentChecker.js"

assertRequiredEnvironment(process.env)
assertEmailEnvironment(process.env)

app.listen(config.port, () => {
    console.log(`Server is running on port ${config.port}`)
    startPaymentChecker()
})
