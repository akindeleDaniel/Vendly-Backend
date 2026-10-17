import type { Prisma } from "../generated/prisma/client.js"

// Conditions (for an OR filter) under which a reservation holds stock:
// - PROTECTED reservations always hold it;
// - ACTIVE reservations hold it until they expire (narrowed by `activeFilter`, for example to
//   leave out the requesting user's own live checkouts);
// - an expired ACTIVE reservation still holds it while its checkout has an unresolved or
//   successful payment attempt. Only the owner's next checkout request marks such a reservation
//   PROTECTED, so every other request must already treat it as protected.
export function heldReservationConditions(
    now: Date,
    activeFilter: Prisma.InventoryReservationWhereInput = {}
): Prisma.InventoryReservationWhereInput[] {
    return [
        { status: "PROTECTED" },
        {
            status: "ACTIVE",
            expiresAt: { gt: now },
            ...activeFilter
        },
        {
            status: "ACTIVE",
            expiresAt: { lte: now },
            checkout: {
                paymentAttempts: {
                    some: { status: { in: ["PENDING", "SUCCESS"] } }
                }
            }
        }
    ]
}
