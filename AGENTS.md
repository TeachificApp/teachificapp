# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Teachific is a full-stack TypeScript monolith: Express backend + React/Vite frontend + MySQL database. All code lives in one repo (`client/`, `server/`, `shared/`, `drizzle/`).

### Prerequisites

- **Node.js 22** (matches Dockerfile `FROM node:22-alpine`)
- **pnpm** (version declared in `packageManager` field of `package.json`)
- **MySQL 8** running locally

### Database setup

MySQL must be running before the dev server starts. Create a database named `teachific` and set `DATABASE_URL` in `.env`:

```
DATABASE_URL=mysql://root@localhost:3306/teachific
```

Push the schema with `DATABASE_URL=mysql://root@localhost:3306/teachific npx drizzle-kit push --force`. There is no `meta/_journal.json` so `drizzle-kit migrate` will not work; use `drizzle-kit push` instead.

### Environment variables

Create a `.env` file in the project root with at minimum:

```
NODE_ENV=development
DATABASE_URL=mysql://root@localhost:3306/teachific
JWT_SECRET=<any-random-string>
```

Optional services (S3, Stripe, SendGrid, OpenAI) degrade gracefully when their env vars are absent.

### Key commands

See `package.json` scripts. Summary:

| Task | Command |
|------|---------|
| Dev server (port 3000) | `pnpm dev` |
| TypeScript check | `pnpm check` |
| Tests | `pnpm test` |
| Build | `pnpm build` |
| Format | `pnpm format` |
| DB schema push | `DATABASE_URL=... npx drizzle-kit push --force` |

### Gotchas

- **esbuild native binary**: After `pnpm install`, esbuild's build scripts may be blocked by pnpm. If `pnpm build` fails with `SyntaxError: Invalid or unexpected token` on the esbuild binary, run the install scripts manually: `cd node_modules/.pnpm/esbuild@*/node_modules/esbuild && node install.js` and similarly for `@tailwindcss/oxide`: `cd node_modules/.pnpm/@tailwindcss+oxide*/node_modules/@tailwindcss/oxide && node scripts/install.js`.
- **Public registration**: By default, registration is closed. Insert a row into `platform_settings` with `allowPublicRegistration = 1` to enable signups: `INSERT INTO platform_settings (id, allowPublicRegistration) VALUES (1, 1) ON DUPLICATE KEY UPDATE allowPublicRegistration = 1;`
- **Test failures**: 2 tests (`appVersions.test.ts` and `sendgrid.test.ts`) require a live database/SendGrid API key respectively and will fail without them. The remaining 12 test files (154 tests) pass without external services.
- **`wouter` patch**: The project patches `wouter@3.7.1` via `patches/wouter@3.7.1.patch`. Ensure the `patches/` directory is present when installing.
