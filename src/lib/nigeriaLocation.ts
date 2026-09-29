import { lgas, states } from "nigerian-states-and-lgas"

export function buildLocation(state: string, lga: string): string | null {
    if (!state || !lga) {
        return null
    }

    const validStates = states()
    if (!validStates.includes(state)) {
        return null
    }

    const lgasInState = lgas(state)
    if (!lgasInState || !lgasInState.includes(lga)) {
        return null
    }

    return `${lga}, ${state}`
}
