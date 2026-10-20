import "dotenv/config"
import prisma from "../src/lib/prisma.js"

// Makes an existing user an administrator, who can issue refunds.
// Usage: npx tsx scripts/makeAdmin.ts someone@example.com
// Run it against the database you mean to change: it prints which one it used.
const email = process.argv[2]?.trim()

if (!email) {
    console.error("Usage: npx tsx scripts/makeAdmin.ts <email>")
    process.exit(1)
}

try {
    const databases = await prisma.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`
    const database = databases[0]?.database ?? "unknown"
    const users = await prisma.user.findMany({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true, email: true, role: true, isAdmin: true }
    })

    if (users.length !== 1) {
        console.error(users.length === 0
            ? `No user with that email in the "${database}" database.`
            : `More than one user matches that email in the "${database}" database, so nothing was changed.`)
        process.exitCode = 1
    } else if (users[0]!.isAdmin) {
        console.log(`${users[0]!.email} is already an administrator in the "${database}" database.`)
    } else {
        await prisma.user.update({ where: { id: users[0]!.id }, data: { isAdmin: true } })
        console.log(`${users[0]!.email} is now an administrator in the "${database}" database.`)
    }
} finally {
    await prisma.$disconnect()
}
