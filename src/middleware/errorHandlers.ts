import type { NextFunction, Request, Response } from "express"

// express.json() leaves req.body undefined when a request has no JSON body. Controllers read
// fields straight from req.body, so an empty object lets their own validation answer with a 400.
export function ensureRequestBody(req: Request, _res: Response, next: NextFunction) {
    if (req.body === undefined) {
        req.body = {}
    }
    next()
}

export function notFoundHandler(_req: Request, res: Response) {
    res.status(404).send({ message: "Route not found" })
}

function errorType(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "type" in error && typeof error.type === "string"
        ? error.type
        : undefined
}

function errorStatus(error: unknown): number | undefined {
    return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? error.status
        : undefined
}

// Final error handler. Express 5 also forwards rejected promises from async route handlers here,
// so errors thrown outside a controller's own try/catch still get a JSON response.
// Stack traces and internal error details are never sent to the client.
export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction) {
    if (res.headersSent) {
        next(error)
        return
    }

    const type = errorType(error)

    if (type === "entity.parse.failed") {
        res.status(400).send({ message: "Request body must be valid JSON" })
        return
    }

    if (type === "entity.too.large") {
        res.status(413).send({ message: "Request body is too large" })
        return
    }

    const status = errorStatus(error)

    if (status !== undefined && status >= 400 && status < 500) {
        res.status(status).send({ message: "The request could not be processed" })
        return
    }

    console.error("Unhandled request error", { method: req.method, path: req.path }, error)
    res.status(500).send({ message: "Sorry there is an issue on our end" })
}
