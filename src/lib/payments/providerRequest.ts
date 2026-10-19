import { PaymentProviderError } from "./types.js"

const providerTimeoutMs = 15_000

type ProviderRequest = {
    providerName: string
    secretKeyVariable: string
    url: string
    method?: "GET" | "POST" | "PUT"
    body?: unknown
    isSuccess(body: unknown): boolean
}

// Sends an authenticated JSON request to a payment provider and returns the parsed body.
// Never call this inside a database transaction.
export async function sendProviderRequest(request: ProviderRequest): Promise<Record<string, unknown>> {
    const secretKey = process.env[request.secretKeyVariable]?.trim()

    if (!secretKey) {
        throw new PaymentProviderError("unavailable", `${request.providerName} is not configured`, `${request.secretKeyVariable} is not set`)
    }

    let response: Response

    try {
        response = await fetch(request.url, {
            method: request.method ?? "GET",
            headers: {
                Authorization: `Bearer ${secretKey}`,
                ...(request.body !== undefined ? { "Content-Type": "application/json" } : {})
            },
            body: request.body !== undefined ? JSON.stringify(request.body) : null,
            signal: AbortSignal.timeout(providerTimeoutMs)
        })
    } catch (error) {
        throw new PaymentProviderError(
            "unavailable",
            `${request.providerName} could not be reached`,
            error instanceof Error ? error.name : undefined
        )
    }

    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    const providerMessage = typeof body?.message === "string" ? body.message : undefined

    if (response.ok && body && request.isSuccess(body)) {
        return body
    }

    // 4xx responses (other than rate limiting) mean the provider refused this request.
    const rejected = response.status >= 400 && response.status < 500 && response.status !== 429

    throw new PaymentProviderError(
        rejected ? "rejected" : "unavailable",
        `${request.providerName} ${rejected ? "rejected" : "failed"} the request`,
        `HTTP ${response.status}${providerMessage ? `: ${providerMessage}` : ""}`
    )
}

export function readDataString(body: Record<string, unknown>, field: string): string {
    const data = body.data as Record<string, unknown> | undefined
    const value = data?.[field]

    if (typeof value !== "string" || !value.trim()) {
        throw new PaymentProviderError("unavailable", "Unexpected provider response", `Missing data.${field}`)
    }

    return value.trim()
}
