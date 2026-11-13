# Unkillable Agent Workflows

Durable agent workflows with human approval, built to demonstrate recovery you can inspect.

The platform targets five goals: crash durability, exactly-once side effects, human control, debuggable run history, and measured chaos-test evidence. This is a separate project from OrgMind; a future optional HTTP retriever adapter is its only integration.

## Current scope

Step 1 provides the TypeScript monorepo, Express health endpoint, BullMQ logging worker, Next.js dashboard shell, local infrastructure, and CI. Workflow execution, authentication, approvals, and chaos controls are future steps. No reliability numbers are claimed yet.

## Quickstart

Install Node.js 24 or newer, pnpm 12.16.1, and Docker with Compose. From the repository root:

```powershell
Copy-Item .env.example .env
pnpm install
docker compose up -d
pnpm dev
```

Open http://localhost:3000. The API badge turns green when MongoDB and Redis are reachable. The worker logs `Worker ready`, then its health every 30 seconds. The API is at http://localhost:4000/health; Mailpit is at http://localhost:8025. Stop app processes with Ctrl+C and infrastructure with `docker compose stop` (retains data).

MongoDB runs as a single-node replica set. The one-shot initializer safely initiates `rs0` on a fresh volume. Host applications use `directConnection=true` because the replica set advertises the internal Compose hostname `mongo`. Services bind only to local loopback ports. This setup is for local development.

The checked-in environment example defines `NODE_ENV`, `API_PORT`, `CORS_ORIGINS` (comma-separated allowlist), `MONGODB_URI`, `REDIS_URL`, `LOG_LEVEL`, and `NEXT_PUBLIC_API_URL`. API and worker load the root `.env`; the web health proxy defaults to port 4000. For a custom API URL, set `NEXT_PUBLIC_API_URL` in `apps/web/.env.local` too. No model, payment, SMTP, or Telegram credentials are needed in Step 1.

## Workspace

| Package              | Responsibility                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `apps/web`           | Next.js App Router, Tailwind, shadcn-style local Button, theme toggle and health proxy                      |
| `apps/api`           | Express 5 routes → controllers → services; request IDs, validation, consistent errors and dependency health |
| `apps/worker`        | BullMQ `workflow-runs` consumer; logs job IDs, without executing workflows                                  |
| `packages/shared`    | Shared Zod contracts and infrastructure configuration                                                       |
| `packages/workflows` | Typed definition contract; graph execution begins in Step 3                                                 |

Validation results are available on `res.locals.body`, `.query`, or `.params`, avoiding mutation of Express 5 request getters. Health returns HTTP 503 with per-service flags when a dependency fails. Shutdown stops accepting work, closes connections, and has a ten-second deadline.

## Development checks

If `pnpm dev` reports missing `tsx` or Next.js CLI files, stop the dev processes, restore the installed packages and links with `pnpm install --frozen-lockfile --force`, then retry `pnpm dev`. A normal install can report everything up to date even when local package links are damaged. This repair keeps the dependency versions in the lockfile. If React declarations still fail to resolve, the generated hoisted links in `node_modules/.pnpm/node_modules` may also need rebuilding; remove only that generated directory and repeat the forced install.

The prepare script uses Husky 9's `bin.js` entry point and skips hook setup when `CI` is set, `HUSKY=0`, or the directory has no `.git` entry.

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Tests inject dependency probes and never use real services or models. CI runs these checks on Node 24. `pnpm format` formats the workspace. Husky installs only when a Git checkout exists; lint-staged checks staged files. No Git history is created by the scaffold.

Official references consulted for the foundation: [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [Express error handling](https://expressjs.com/en/guide/error-handling/), [BullMQ graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown), and [shadcn manual installation](https://ui.shadcn.com/docs/installation/manual). Exact installed dependency versions are recorded in `pnpm-lock.yaml`.

## Roadmap and working agreement

The complete user-approved specification is preserved in [docs/BUILD-PROMPT.md](docs/BUILD-PROMPT.md). Work proceeds one step at a time, with review between steps. See [docs/PROGRESS.md](docs/PROGRESS.md) for actual implementation and verification status.

## Author

**Jahid Khan Tuhin — Full Stack JavaScript Engineer**

GitHub: [placeholder] · LinkedIn: [placeholder] · Email: [placeholder]
