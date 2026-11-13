# Step 2: Domain model, authentication, and RBAC

Author: Jahid Khan Tuhin, Full Stack JavaScript Engineer.

This step creates a single local workspace with viewer, approver, and admin memberships. New accounts always receive viewer access. Roles are not accepted from registration input; the local seed command is the only role assignment tool in this step. There is no public role-management endpoint.

Better Auth 1.7.23 owns identity, credentials, and session persistence through its official MongoDB adapter, with transactions enabled by passing the MongoClient. Application auth routes are thin wrappers: validation → controller → service → Better Auth handler and membership repository. The native handler runs on a constructed Request, so Express consuming the original JSON body does not interfere with Better Auth's request processing. Only the four supported auth operations and read-only section permission probes are exposed.

The browser uses a same-origin, allowlisted Next.js proxy. It forwards cookies and the browser's Origin without inventing or trusting client-supplied roles. Mutating API auth routes require an exact trusted Origin. Session cookies are HttpOnly/SameSite=Lax, and Secure in production. The signing secret remains on the API, passwords are hashed by Better Auth, session tokens are never returned in application JSON, and logs redact credential-bearing headers. Parsed request bodies are not logged; malformed-JSON errors are logged without their potentially sensitive body.

Sessions have a fixed seven-day lifetime and do not use cookie-cached identity. Every protected API request reads the current membership, so a demotion or missing membership takes effect immediately. Navigation refreshes its identity when the window regains focus; protected pages verify on the server independently of the navigation. An unavailable API produces an error page instead of silently treating the user as authorized. Email verification and password recovery are outside this local step, and no email delivery is configured.

Auth creates the viewer membership in an after-create hook. If membership persistence fails after the identity transaction commits, access fails closed; re-running local seed for that email can repair the membership. The seed command preserves existing passwords, applies its configured role, and refuses production mode. Keep the same private signing secret across restarts.

Shared Zod schemas cover all domain collections and Better Auth records. Application repository methods validate data at the persistence boundary. Better Auth owns its own adapter internals and auth-record validation; no duplicate password or session implementation is maintained. `idempotencyKeys.key` is unique, but effect execution and the exactly-once helper remain Step 4 work. Event schemas are contracts only; no execution/SSE machinery is implemented yet.

API startup and `pnpm db:migrate` both run the idempotent index bootstrap. Indexes fail startup if a conflicting database definition prevents guarantees from being established. The integration suite uses random `unkillable_test_*` databases and drops only those databases afterward. Ordinary unit/auth tests use the official memory adapter; CI additionally exercises the real MongoDB adapter and its transactions. Auth rate limiting is enabled in the running app and disabled in the isolated test fixtures so test order cannot spend shared limits.

Verified UI screenshot: [signed-in administrator](screenshots/step-2-admin.jpg).

Reference documentation: [MongoDB adapter](https://better-auth.com/docs/adapters/mongo), [database hooks and model names](https://better-auth.com/docs/concepts/database), [session configuration](https://better-auth.com/docs/concepts/session-management). Next.js's installed authentication and cookies guides were also checked before implementation.
