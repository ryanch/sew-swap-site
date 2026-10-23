# Sew Swap

Swap site: managers create swaps with a registration form, users sign up, the manager pairs them, and partners see each other's shared info. Helpers manage "pods" in large swaps. Users aren't comfortable with technology, so notifications go by email, with an in-app log of those emails (`EmailLog`, shown at `/emails`). Will deploy to **GCP Cloud Run + Firestore** (Native mode, chosen over Spanner for cost).

## Stack
- `apps/api`: Node 22, Fastify, TypeScript (CommonJS), `@google-cloud/firestore`, nodemailer
- `apps/web`: React 19, Vite, react-router. Production is nginx, which proxies `/api` to `$API_UPSTREAM`.
- `apps/api/src/db/firestore.ts`: the client, every collection (with its fields) and transaction helpers. No schema or migrations. `db/people.ts` reads users and profiles together.
- `e2e/`: Playwright tests that read the sign-in emails from the Mailpit API
- Local services: Firestore emulator on :8081, Mailpit on :8025 (UI) and :1025 (SMTP)

## Commands
```sh
docker compose up -d --build                         # web :5173, api :8080
docker compose --profile test run --rm --build e2e   # e2e tests
docker compose restart firestore                     # empty the database
docker build --target prod apps/api                  # prod image (same for apps/web)
docker compose exec api npm run seed:demo            # emulator only: new open swap owned by the admin, 50 makers
```
The demo seed (`src/scripts/seedDemoSwap.ts`) reuses `demo01…demo50@example.test`: 5 in Hawaii, 8 in Canada, 37 elsewhere in the US, 10 at each skill level, all in Default with no pairings. Each run adds another swap. Run it again after restarting `firestore`.

Node isn't installed on the host, so run npm inside containers. If docker can't find `docker-credential-desktop`, add `/Applications/Docker.app/Contents/Resources/bin` to PATH.

## Auth (done)
- Passwordless email login: a link and a 6-digit code (`LoginTokens`), plus optional Google OAuth, enabled when `GOOGLE_CLIENT_*` is set.
- Database-backed sessions in an httpOnly `sid` cookie. The first login creates the user.
- `request.user` is set by `src/auth/plugin.ts`. Protect routes with `{ preHandler: requireAuth }`.
- The API accepts only JSON request bodies (CSRF defense).

## Gotchas
- **Index rule.** Queries may only use equality filters (any number, including `in`), or a single range/orderBy on one field with no other filters. Do anything else (sorting, time windows, counts, substring search) in memory. Production Firestore rejects queries that need a composite index, but the emulator never does, so tests won't catch a mistake. No collection-group queries either.
- Collections are top-level. Fields use the old PascalCase column names. Ids that stood in for composite keys come from `memberId`/`assignmentId`.
- Store times as `Timestamp`s (`now()`), and send them with `toIso()` (UTC, whole seconds). Sort on the `Timestamp`, not the string. Swap dates are `YYYY-MM-DD` strings, compared to `todayUtc()`.
- Transactions do every read before any write (`inTransaction` and `Problem` are in `db/firestore.ts`).
- Emails and Google ids stay unique through `userEmails/{Email}` and `userGoogleSubs/{GoogleSub}` docs, created in the same transaction as the user.
- The emulator keeps data in memory until the `firestore` container restarts. e2e uses `workers: 1` because the tests share the admin's rate limits.
- e2e: the `data-*.spec.ts` files test the API directly, without the UI. `e2e/helpers` isn't mounted, so add `--build` after changing it.
- The Vite dev server allows host `web` (needed by the e2e container).

## Roles (done)
- Two scopes. **Global roles** live in `users.Roles` (sorted, with `RoleGrants` saying who granted each one) and are granted by admins at `/admin/users`: `admin` (can do everything) and `swap_manager` (can create swaps). Every signed-in person is a regular user, which needs no role.
- **Swap roles** (`manager`, `helper`, `participant`) are typed in `src/auth/roles.ts` but are stored in `swapMembers`.
- `request.user.roles` is loaded with the session. Protect routes with `{ preHandler: requireRole('admin') }`. Admin implies every role (`hasRole`).
- Emails in `ADMIN_EMAILS` get `admin` when they sign in. That role can't be removed in the app, and no admin can remove their own Admin role. Admins can't create users; accounts are made on first sign-in.
- Locally, `admin@example.test` is the admin (e2e signs in as it), and compose raises `LOGIN_REQUESTS_PER_HOUR` to 50.

## Swaps (done)
- `Swaps` (title, description, five `DATE` columns) and `SwapMembers(SwapId, UserId, Role)` (see Joining swaps). Dates are stored, sent and taken as `YYYY-MM-DD` strings.
- Any signed-in user can browse `/swaps` and open a detail page.
- Swap managers (and admins) create swaps at `/manage/swaps`. The creator gets a `manager` row in `SwapMembers`. Only that swap's managers and admins can edit it (`canManage` in `src/swaps/access.ts`).

## Joining swaps (done)
- `SwapMembers` is keyed `(SwapId, UserId, Role)`, so anyone can join as a `participant`, including a swap's own manager or an admin, without losing their other role.
- `PUT`/`DELETE /api/swaps/:swapId/membership` join and leave. Joining works only from `SignUpOpens` through `SignUpCloses` inclusive, compared to `todayUtc()`. Leaving is always allowed and removes only the participant row (and that person's assignments).
- `GET /api/swaps/:swapId/members` (managers and admins) lists participants with keyset pagination on `UserId` (`limit`, `after`, returns `nextCursor` and `total`). The UI is `/manage/swaps/:swapId/members`.
- e2e swaps that must stay "not open" use 2099 dates; tests that need an open swap compute dates from today.

## Swap sign-up (done)
- Joining is a form at `/swaps/:swapId/join`: the account email (read-only, already verified by sign-in), a mailing address (with First name and Last name fields; `RecipientName` keeps the combined label, and older profiles are split on the last space), and an Instagram name. Saved per user in `userProfiles` and prefilled next time.
- `PUT …/membership` takes `{ address, instagramPublicConfirmed? }`. It answers 404/403 for missing or closed swaps before looking at the body, then needs a valid address (`src/profile/address.ts`: US state + ZIP, Canadian province + postal code, free text elsewhere) and a passing Instagram check from the last 30 days.
- `POST /api/me/instagram/check` cleans the input (`src/instagram/handle.ts`: `@John`, `instagram.com/john/` → `john`) and runs the strategies in `INSTAGRAM_CHECK_STRATEGIES` in order (`src/instagram/strategies.ts`). Results: `public`, `private` and `not_found` are decisive; `exists` and `unknown` let the person join if they tick "my account is public", and managers see "Instagram unconfirmed". A failed check clears the saved handle.
- Instagram breaks these often. In Oct 2026 `webProfileInfo` was refused (401) and `crawlerPage` could tell real accounts from missing ones but not public from private. `InstagramChecks.Strategy` records which strategy decided each check. To add an approach, add an `InstagramStrategy` and list it in the env var.
- Checks are rate limited per user (`INSTAGRAM_CHECK_MIN_SECONDS` apart, 15 per hour) and the button counts down. Compose uses the `fake` strategy (prefixes `private`, `nosuch`, `exists`, `unknown`; anything else is public) and a 2-second gap.
- Unit tests: `docker compose exec api npx tsx --test src/**/*.test.ts`.

## Pods and pairing (done)
- `pods` (`SwapId`, `PodId`, `Name`), `SwapMembers.SkillLevel` (1–5) and `.PodId` on participant rows, and `Assignments(SwapId, MakerId, RecipientId)` (maker makes for recipient). All manager-only: routes in `routes/pods.ts` check `canManage` (`src/swaps/access.ts`) and nothing reaches participants.
- The Default pod is virtual: `PodId` NULL, `default` in URLs, always listed, can't be renamed or deleted. A person is in one pod, but can make for anyone in the swap, up to `MAX_RECIPIENTS` (5). Moving people between pods or deleting a pod never changes assignments.
- `GET …/members` takes filters (`pod`, `exceptPod`, `q`, `country`, `region`, `skill` incl. `none`, `needs=maker|recipient`) and returns skill, pod, `makingFor`, `madeBy`. Same keyset pagination.
- Split (`src/pods/split.ts`) sorts by skill, country, region, postal code into even pods named "<pod> N", then deletes the old pod. Auto-assign (`src/pods/loop.ts`) only adds rows: it chains existing pairings into one shuffled loop and reports who's left over.
- Leaving a swap deletes the person's assignments both ways; the members page's "Needs attention" filter shows the gaps.
- `GET …/export.csv`: one row per participant, with the Instagram link, address, pod, skill, `Making For` … `Making For 5`, `Made by`. Cells are formula-guarded (`src/pods/csv.ts`).
- Managers rate skill by looking at Instagram, so manager views always show `@handle` as a link next to the skill picker (`src/swaps/manage.tsx` in web).

## Publishing makers (done)
- `Swaps.MakersPublishedAt`/`By`, `Assignments.ConfirmedAt`, and `EmailLog(UserId, EmailId, Kind, SwapId, Subject, Body)`. Routes are in `routes/makes.ts`.
- Managers publish by hand. "Partners announced" is only a guide. The panel on the members page and swap page (`PublishPanel` in `swaps/manage.tsx`) warns if anyone is unpaired, but still allows publishing. Publishing asks twice (inline, then `confirm()`), then emails every maker. You can only publish once (409 after).
- Before publishing, `GET /api/me/makes` and the confirm route show nothing (404), so pairings stay private.
- Makers confirm at `/makes` by ticking three boxes, which the API checks too. The home page shows a big button when something needs confirming. `src/auth/returnTo.ts` (localStorage) sends people back to `/makes` after signing in from the email link.
- Pairings stay editable after publishing. A new one is unconfirmed and emails the maker (`new_pairing`).
- `needs=confirmation` lists makers with an unconfirmed pairing. `POST …/reminders` takes up to 50 `userIds` per batch and skips anyone confirmed or reminded in the last 24 hours.
- Send notifications with `sendUserMail`. It logs to `EmailLog` as `sending`, then `sent` or `failed`. Only `sent` rows count as sent; `sending` rows still hold back repeat reminders, in case the email went out and `sendToMany` (5 at a time, before the reply, because Cloud Run throttles CPU after it). Sign-in emails aren't logged.

## Shipping (done)
- `Assignments.ShippedAt`, `.Carrier` and `.TrackingNumber`. Makers ship at `/makes` (`POST …/makes/:recipientId/ship` with `{ carrier, trackingNumber }`). It's 404 before publishing and 409 until that pairing is confirmed. Sending a new number corrects it.
- Carriers and tracking links are in `src/shipping/tracking.ts`. The maker picks the carrier, and the page pre-selects a guess (`guessCarrier` in web `swaps/swaps.ts`). `other` has no link. USPS and Purolator answer 403 to curl (bot protection), so check their links in a browser.
- Shipping emails the recipient (`package_shipped`) the tracking, and their swap page shows it (`membership.packages`). Neither ever names the maker.
- `POST …/reminders` takes `kind: 'confirm' | 'ship'` (default `confirm`). Ship reminders go to anyone with an unshipped pairing, confirmed or not, any time after publishing. Each kind has its own 24-hour gap. `needs=shipping` lists them, and the members page sends them in batches.
- Manager views and the CSV (`Make N Shipped`, `Make N Tracking`, `Make N Tracking link`) show each pairing's tracking. A maker counts as shipped (`makersShipped`) only when every pairing has shipped.

## Next
- Helpers scoped to pods.
- Partner pairings (partners see each other's shared info).
