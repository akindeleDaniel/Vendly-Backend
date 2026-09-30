type RouteMatrixCell = {
    distance?: unknown
} | null

type RouteMatrixResponse = {
    sources_to_targets?: RouteMatrixCell[][]
}

export function getRouteCandidateLimit(shopCount: number): number {
    if (shopCount <= 20) {
        return shopCount
    }

    return shopCount <= 40 ? 40 : 80
}

export async function getDrivingRouteDistances(
    origin: { latitude: number; longitude: number },
    destinations: Array<{ latitude: number; longitude: number }>
): Promise<Array<number | null>> {
    const apiKey = process.env.GEOAPIFY_API_KEY

    if (!apiKey) {
        throw new Error("GEOAPIFY_API_KEY is not configured")
    }

    const url = new URL("https://api.geoapify.com/v1/routematrix")
    url.searchParams.set("apiKey", apiKey)

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            mode: "drive",
            sources: [{ location: [origin.longitude, origin.latitude] }],
            targets: destinations.map(({ latitude, longitude }) => ({
                location: [longitude, latitude]
            })),
            units: "metric"
        }),
        signal: AbortSignal.timeout(10_000)
    })

    if (!response.ok) {
        throw new Error(`Geoapify route matrix returned ${response.status}`)
    }

    const data = await response.json() as RouteMatrixResponse
    const distances = data.sources_to_targets?.[0]

    if (!distances || distances.length !== destinations.length) {
        throw new Error("Geoapify route matrix returned an invalid result")
    }

    return distances.map((cell) => {
        if (cell === null || cell?.distance === null) {
            return null
        }

        if (
            !cell ||
            typeof cell.distance !== "number" ||
            !Number.isFinite(cell.distance) ||
            cell.distance < 0
        ) {
            throw new Error("Geoapify route matrix returned an invalid distance")
        }

        return cell.distance
    })
}
