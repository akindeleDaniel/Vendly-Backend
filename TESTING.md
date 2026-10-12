# Backend tests

The test runner uses Node's built-in test runner, the existing `tsx` TypeScript loader, and the generated Prisma client. No additional test framework is required.

## Configure a dedicated PostgreSQL database

Create a separate database named `vendly_test` and grant the test role permission to connect, create schema objects, and apply the repository migrations. Do not point this database at development or production data.

Copy `.env.test.example` to `.env.test` (the destination is gitignored) and configure:

```dotenv
VENDLY_TEST_DATABASE=vendly_test
TEST_DATABASE_URL=postgresql://YOUR_LOCAL_POSTGRES_USER:YOUR_LOCAL_POSTGRES_PASSWORD@localhost:5432/vendly_test?schema=public
```

Replace the username and password placeholders with your local PostgreSQL credentials. URL-encode any reserved characters in those values.

Keep the normal development `DATABASE_URL` in `.env`. For local development, the only approved PostgreSQL test hosts are `localhost`, `127.0.0.1`, and `::1` (IPv6 loopback). Hostnames are compared case-insensitively, with a trailing dot and IPv6 URL brackets normalized. The allowlist is fixed in the test runner; remote test hosts are intentionally rejected.

The test runner requires both URLs, the explicit `VENDLY_TEST_DATABASE=vendly_test` selection, an approved test host, and a distinct target database named exactly `vendly_test`. It connects and verifies PostgreSQL's reported database name before running `prisma migrate deploy`; it never resets or cleans a database. The URL is not printed.

## Run tests

```sh
npm test
```

This command applies any pending repository migrations to the validated test database, then runs `tests/postgres.integration.test.ts`. The integration test verifies a real Prisma connection and PostgreSQL Serializable transaction isolation.

Run the database-target safety checks without connecting to or modifying any database:

```sh
npm run test:guard
```

The guard tests cover missing opt-in/configuration and development-database collision rejection. Add future database integration tests under `tests/` and use `connectTestDatabase()` from `scripts/testDatabase.ts`; the helper independently validates the target before constructing Prisma.
