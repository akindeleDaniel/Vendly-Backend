type GeoapifyResult = {
    lat?: unknown
    lon?: unknown
}

type GeoapifyResponse = {
    results?: GeoapifyResult[]
}

export async function geocodeLocation(location: string): Promise<{ latitude: number; longitude: number } | null> {
    const apiKey = process.env.GEOAPIFY_API_KEY

    if (!apiKey) {
        return null
    }

    const url = new URL("https://api.geoapify.com/v1/geocode/search")
    url.searchParams.set("text", location)
    url.searchParams.set("filter", "countrycode:ng")
    url.searchParams.set("limit", "1")
    url.searchParams.set("apiKey", apiKey)

    try {
        const response = await fetch(url)

        if (!response.ok) {
            return null
        }

        const data = await response.json() as GeoapifyResponse
        const result = data.results?.[0]

        if (
            !result ||
            typeof result.lat !== "number" ||
            typeof result.lon !== "number" ||
            !Number.isFinite(result.lat) ||
            !Number.isFinite(result.lon)
        ) {
            return null
        }

        return {
            latitude: result.lat,
            longitude: result.lon
        }
    } catch {
        return null
    }
}
