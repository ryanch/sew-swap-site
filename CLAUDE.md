# Sew Swap

Swap site: managers create swaps with a registration form, users sign up, the manager pairs them, and partners see each other's shared info. Helpers manage "pods" in large swaps. Users aren't comfortable with technology, so notifications go by email, with an in-app log of those emails. Will deploy to **GCP Cloud Run + Cloud Spanner**.

## Stack
- `apps/api`: Node 22, Fastify, TypeScript (CommonJS), `@google-cloud/spanner`, nodemailer
- `apps/web`: React 19, Vite, react-router. Production is nginx, which proxies `/api` to `$API_UPSTREAM`.
- `db/migrations/*.sql`: Spanner DDL in the GoogleSQL dialect, applied in order by `apps/api/src/db/bootstrap.ts` (emulator only)
- `e2e/`: Playwright tests that read the sign-in emails from the Mailpit API
- Local services: Spanner emulator on :9010, Mailpit on :8025 (UI) and :1025 (SMTP)

## Commands
```sh
docker compose up -d --build                         # web :5173, api :8080
docker compose --profile test run --rm --build e2e   # e2e tests
docker compose restart spanner api                   # after any migration change
docker build --target prod apps/api                  # prod image (same for apps/web)
```
Node isn't installed on the host, so run npm inside containers. If docker can't find `docker-credential-desktop`, add `/Applications/Docker.app/Contents/Resources/bin` to PATH.

## Auth (done)
- Passwordless email login: a link and a 6-digit code (`LoginTokens`), plus optional Google OAuth, enabled when `GOOGLE_CLIENT_*` is set.
- Database-backed sessions in an httpOnly `sid` cookie. The first login creates the user.
- `request.user` is set by `src/auth/plugin.ts`. Protect routes with `{ preHandler: requireAuth }`.
- The API accepts only JSON request bodies (CSRF defense).

## Gotchas
- The emulator keeps data in memory. Restarting only `api` keeps the old schema.
- Columns written with `Spanner.COMMIT_TIMESTAMP` need `OPTIONS (allow_commit_timestamp = true)`.
- The emulator allows one read-write transaction at a time, so e2e uses `workers: 1`. Real Spanner doesn't have this limit.
- The Vite dev server allows host `web` (needed by the e2e container).

## Next: roles and swaps
Roles: Admin (creates any user, sees all swaps), Swap Manager, Swap Helper (pods), User (signs up for swaps).
