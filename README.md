# Sew Swap

React (Vite) frontend + Fastify API + Cloud Spanner emulator + Mailpit, all in Docker.
Users sign in with a passwordless email link/code or (optionally) Google.

## Run locally

```sh
docker compose up --build
```

| What | URL |
|---|---|
| Web app | http://localhost:5173 |
| API health | http://localhost:8080/api/health |
| Mailpit inbox | http://localhost:8025 |
| Spanner emulator | `localhost:9010` (gRPC), `localhost:9020` (REST) |

On startup the API creates the Spanner instance and database in the emulator and applies `db/migrations/*.sql`.
The emulator keeps data in memory only, so the data resets on every restart.

Hot reload: `apps/web/src` and `apps/api/src` are bind-mounted. If you change `package.json`, rebuild with `docker compose up --build`.

**After changing `db/migrations/`**, restart the emulator too so the database is recreated:
`docker compose restart spanner api` (restarting only `api` keeps the old schema).
Optional overrides go in a `.env` file (see `.env.example`).

## Signing in

- Go to http://localhost:5173 and enter any email address. The first sign-in creates the account.
- The sign-in email arrives in Mailpit (http://localhost:8025). It has a button and a 6-digit code; either one signs you in.
- Each link or code works once and expires after 15 minutes. You can request at most 5 emails per address per hour.

### Admins and roles

Emails listed in `ADMIN_EMAILS` (comma-separated) become admins when they sign in. Locally the default is `admin@example.test`. Admins open **Manage user roles** on the home page and grant or remove *Admin* and *Swap Manager* for anyone who has signed in. Locally, compose allows 50 sign-in emails per address per hour (`LOGIN_REQUESTS_PER_HOUR`) instead of 5.

### Enabling Google sign-in (optional)

1. In the GCP console, go to **APIs & Services → Credentials**. Create an **OAuth client ID** of type *Web application*.
2. Add the authorized redirect URI `http://localhost:5173/api/auth/google/callback`.
3. Put `GOOGLE_CLIENT_ID=...` and `GOOGLE_CLIENT_SECRET=...` in `.env`, then run `docker compose up -d api`.

The "Sign in with Google" button appears once both are set. If a Google account's email matches an existing email-login user, it signs in to that same account.

## Tests

End-to-end tests (Playwright) live in `e2e/`. They cover signup via email link, returning-user login, single-use links, and admin role management. They read the sign-in emails from Mailpit's API.

```sh
docker compose up -d --build                         # stack must be running
docker compose --profile test run --rm --build e2e   # run the tests
```

The HTML report is written to `e2e/playwright-report/`. To run on the host instead (needs Node): `cd e2e && npm ci && npx playwright install chromium && npx playwright test`.

## Layout

```
apps/api   Fastify + TypeScript API (Cloud Run service)
apps/web   React + Vite SPA, served by nginx in prod (Cloud Run service)
db/        Spanner DDL migrations (GoogleSQL)
e2e/       Playwright end-to-end tests
```

## Production images

Each Dockerfile has a `dev` target (used by compose) and a `prod` target (for Cloud Run):

```sh
docker build --target prod -t sew-swap-api apps/api
docker build --target prod -t sew-swap-web apps/web
```

Both listen on `$PORT`. The web image proxies `/api/*` to `$API_UPSTREAM`, which should be set to the API's Cloud Run URL. This keeps the browser on a single origin.
Outside compose, `API_UPSTREAM` must be set, or nginx won't start (it can't resolve the default host `api`).

In production, leave out `SPANNER_EMULATOR_HOST`. Also set `APP_BASE_URL` to the public https URL, which also turns on `Secure` cookies. Set `AUTH_SECRET` to a long random value from Secret Manager. The API then uses Application Default Credentials and does not try to create the instance or database.
