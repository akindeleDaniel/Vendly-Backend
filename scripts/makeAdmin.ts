import "dotenv/config"
import prisma from "../src/lib/prisma.js"

// Makes an existing user an administrator, who can issue refunds. With --super they become a super administrator, who
// can also manage the team and see the platform figures (an administrator who is already one is upgraded).
// Usage: npx tsx scripts/makeAdmin.ts someone@example.com [--super]
// Run it against the database you mean to change: it prints which one it used.
const makeSuper = process.argv.includes("--super")
const email = process.argv.slice(2).find((argument) => !argument.startsWith("--"))?.trim()

if (!email) {
    console.error("Usage: npx tsx scripts/makeAdmin.ts <email> [--super]")
    process.exit(1)
}

try {
    const databases = await prisma.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`
    const database = databases[0]?.database ?? "unknown"
    const users = await prisma.user.findMany({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true, email: true, role: true, isAdmin: true, isSuperAdmin: true }
    })

    if (users.length !== 1) {
        console.error(users.length === 0
            ? `No user with that email in the "${database}" database.`
            : `More than one user matches that email in the "${database}" database, so nothing was changed.`)
        process.exitCode = 1
    } else if (users[0]!.isAdmin && (!makeSuper || users[0]!.isSuperAdmin)) {
        console.log(`${users[0]!.email} is already ${users[0]!.isSuperAdmin ? "a super administrator" : "an administrator"} in the "${database}" database.`)
    } else {
        await prisma.user.update({ where: { id: users[0]!.id }, data: { isAdmin: true, ...(makeSuper ? { isSuperAdmin: true } : {}) } })
        console.log(`${users[0]!.email} is now ${makeSuper ? "a super administrator" : "an administrator"} in the "${database}" database.`)
    }
} finally {
    await prisma.$disconnect()
}
