function toRadians(degrees: number): number {
    return degrees * (Math.PI / 180)
}

export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371 // Earth's radius in km

    const lat1Rad = toRadians(lat1)
    const lng1Rad = toRadians(lng1)
    const lat2Rad = toRadians(lat2)
    const lng2Rad = toRadians(lng2)

    const dLat = lat2Rad - lat1Rad
    const dLng = lng2Rad - lng1Rad

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1Rad) * Math.cos(lat2Rad) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2)

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

    return R * c
}