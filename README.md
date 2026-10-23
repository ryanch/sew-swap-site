# Sew Swap

React (Vite) frontend + Fastify API + Firestore emulator + Mailpit, all in Docker.
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
| Firestore emulator | `localhost:8081` |

Firestore has no schema or migrations: collections appear when the API first writes to them (see `apps/api/src/db/firestore.ts`).
The emulator keeps data in memory only, so the data resets when the `firestore` container restarts.

Hot reload: `apps/web/src` and `apps/api/src` are bind-mounted. If you change `package.json`, rebuild with `docker compose up --build`.

To start with an empty database: `docker compose restart firestore`.
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
e2e/       Playwright end-to-end tests
```

## Deploying to GCP

```sh
brew install --cask google-cloud-sdk   # once
./deploy.sh
```

The script asks for the project, admin emails and SMTP settings (saved in `deploy.env`, which is gitignored), and asks for secrets once (stored in Secret Manager). Then it sets up Firestore and the service accounts, and builds and deploys both Cloud Run services. Run it again to ship updates. To change a secret, add a new version and redeploy: `printf '%s' NEW | gcloud secrets versions add smtp-pass --data-file=-`, then `./deploy.sh`.

## Production images

Each Dockerfile has a `dev` target (used by compose) and a `prod` target (for Cloud Run):

```sh
docker build --target prod -t sew-swap-api apps/api
docker build --target prod -t sew-swap-web apps/web
```

Both listen on `$PORT`. The web image proxies `/api/*` to `$API_UPSTREAM`, which should be set to the API's Cloud Run URL. This keeps the browser on a single origin.
Outside compose, `API_UPSTREAM` must be set, or nginx won't start (it can't resolve the default host `api`).

In production, leave out `FIRESTORE_EMULATOR_HOST`. Also set `APP_BASE_URL` to the public https URL, which also turns on `Secure` cookies. Set `AUTH_SECRET` to a long random value from Secret Manager. The API then uses Application Default Credentials and the project's `(default)` Firestore database (Native mode), which needs creating once:

```sh
gcloud firestore databases create --location=<region>
# Delete expired rows automatically (the API ignores expired ones anyway):
gcloud firestore fields ttls update ExpiresAt --collection-group=sessions --enable-ttl
gcloud firestore fields ttls update ExpiresAt --collection-group=loginTokens --enable-ttl
gcloud firestore fields ttls update ExpiresAt --collection-group=instagramChecks --enable-ttl
```

No composite indexes are needed: every query uses only Firestore's automatic single-field indexes.
