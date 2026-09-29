# Vendly Contributor Guide

## Project Context

Vendly is a multi-vendor marketplace. The backend uses TypeScript, Express 5, Prisma, and PostgreSQL.

## Engineering Rules

- Preserve the existing architecture and local patterns unless there is a clear, task-driven reason to change them.
- Prefer simple, maintainable, professional solutions.
- Use RESTful conventions and clear, descriptive names for routes, controllers, models, and variables.
- Follow the existing error-response shape: `{ message }`.
- Keep changes focused on the requested work; do not make unrelated changes.

## Security

- Keep secrets in environment variables; never hard-code credentials or tokens.
- Enforce authentication, authorization, and resource ownership on the server.
- Never expose passwords, password hashes, tokens, or other sensitive data in API responses or logs.

## Working Style

- When a task is ambiguous, inspect the existing code and ask for clarification rather than guessing.
- For educational tasks, explain the intended approach before making substantial changes.
- When suggesting commit messages, use Conventional Commits.
