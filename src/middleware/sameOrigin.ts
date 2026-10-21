import type { NextFunction, Request, Response } from "express"
import config from "../config.js"

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

// Browsers attach an Origin header to every cross-site request that changes something. If it is not our own
// frontend, the request came from another website using the visitor's cookies, so it is refused, even for
// routes that take no body. Requests with no Origin (our own tools, servers, tests) are not browser traffic
// and carry no cookies of a visitor, so they pass. Payment webhooks are mounted before this and never reach it.
export function requireTrustedOrigin(req: Request, res: Response, next: NextFunction) {
    const origin = req.get("origin")

    if (safeMethods.has(req.method) || origin === undefined || origin === config.frontendUrl) {
        next()
        return
    }

    res.status(403).send({ message: "This request is not allowed from that website" })
}
