import { lgas, states } from "nigerian-states-and-lgas"

export function buildLocation(state: string, lga: string): string | null {
    if (!state || !lga) {
        return "All areas are required"
    }

    const validStates = states()
    if (!validStates.includes(state)) {
        return "Invalid state or LGA"
    }

    const lgasInState = lgas(state)
    if (!lgasInState || !lgasInState.includes(lga)) {
        return "Invalid state or LGA"
    }

    return `${lga}, ${state}`
}