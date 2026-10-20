import type { CookieOptions } from "express"
import config from "../config.js"

// Shared by login, registration and logout so that logout clears exactly the cookie that was set.
export const authCookieOptions: CookieOptions = {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite
}
