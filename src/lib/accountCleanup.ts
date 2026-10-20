import prisma from "./prisma.js"

const oneWeekMs = 7 * 24 * 60 * 60 * 1000

// Removes accounts that never confirmed their email within a week (they cannot log in, so they hold
// nothing but an empty cart), and codes and trusted-device records that expired or were revoked more than a week ago.
export async function purgeStaleAccountRecords(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - oneWeekMs)

    await prisma.$transaction(async (tx) => {
        const stale = await tx.user.findMany({
            where: { emailVerifiedAt: null, createdAt: { lt: cutoff } },
            select: { id: true }
        })
        const ids = stale.map((user) => user.id)

        if (ids.length > 0) {
            await tx.cart.deleteMany({ where: { userId: { in: ids } } })
            await tx.user.deleteMany({ where: { id: { in: ids } } })
        }

        await tx.emailOtp.deleteMany({ where: { expiresAt: { lt: cutoff } } })
        await tx.trustedDevice.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] } })
    })
}
