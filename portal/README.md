# Prescription Repository Portal

Read-only administration portal for the CDU ↔ eRegister prescription repository.

```
Browser ──► portal :3000 ──(read-only OpenHIM client "portal")──► OpenHIM :5001 ──► HAPI FHIR
               │  OIDC login (authorization code + PKCE)
               └──► Keycloak :8180, realm "bonolo-repository" (users, roles, MFA)
```

- `server/`: Node 24 + Fastify, written in TypeScript and run directly by Node (type stripping), so there is no build step. It handles the Keycloak login, enforces roles on every API call, and is the only part holding the OpenHIM credentials.
- `web/`: React 19 + Mantine + React Router, built with Vite and served by the server.

## Run

Keycloak and the portal are services in the repository's `docker-compose.yml`:

```sh
docker compose up -d --build keycloak portal
./scripts/setup-openhim.sh     # registers the read-only "portal" OpenHIM client
```

Open http://localhost:3000. The demo users are created on Keycloak's first start, with passwords from `.env`:

| User | Role | Sees |
|---|---|---|
| `repo.admin` | repo-admin | everything, including user management |
| `support.clerk` | support | dashboard, prescriptions, integration health |
| `programme.manager` | programme-manager | dashboard only (aggregate figures, no patient details) |

The Keycloak admin console is at http://localhost:8180/admin (`admin` / `KEYCLOAK_ADMIN_PASSWORD`). The realm in `keycloak/bonolo-repository-realm.json` is imported on first start only; later changes go through the console (or recreate the `keycloak-db-data` volume).

## Dashboard

The dashboard covers prescriptions (fulfilment Tasks) authored in the chosen period: 7 days, 30 days, 90 days or 12 months. The server reads them in pages of 500 with their MedicationRequests (`Task?authored-on=ge…&_include=Task:focus`) and returns only counts, which is why programme managers may see it.

- **Status:** follows the "Status Map" tab of the data-mapping sheet. A Task back in `requested` counts as *Sent to CDU* whatever its previous businessStatus.
- **Cancelled by facility or CDU:** eRegister also cancels the MedicationRequest; the CDU never changes it.
- **Waiting too long:** a Task still `requested` with no change for longer than `PORTAL_UNCLAIMED_ALERT_HOURS` (default 2) raises a warning.
- **Caching:** results are cached per period for `PORTAL_DASHBOARD_CACHE_SECONDS` (default 60); **Refresh** bypasses the cache.
- **Dates:** days are calendar days in `PORTAL_TIME_ZONE` (default `Africa/Maseru`).
- **Large periods:** above 20,000 prescriptions in one period the figures are marked partial. Before that volume, move the counts to `_summary=count` queries or a metrics store.

## Prescriptions (administrators and support only)

Prescriptions show patient details, so the routes require the `repo-admin` or `support` role; programme managers get 403.

**Search filters**
- eRegister ID (`patient.identifier`)
- patient name (`patient.name`, prefix match)
- order ID (Task identifier)
- facility (`requester`)
- status (Status Map: `business-status`, or `status=requested` for *Sent to CDU*)
- date written (`authored-on`)

Filters live in the URL, so a search can be bookmarked or shared. Results are newest first, 25 per page.

**Paging:** pages follow HAPI's own paging links. The browser only holds an opaque cursor, and the server accepts only HAPI's paging keys in it. HAPI keeps a search for a limited time; an expired cursor asks the user to search again.

**Not yet filterable:** pickup point. It sits in a MedicationRequest extension, which has no FHIR search parameter. Adding a SearchParameter for it to the IG would make it searchable.

**Detail view**
- patient, prescription, CDU status and reason, allergies, recorded dispenses
- a history built from the version history (`_history`) of the Task and the MedicationRequest

The history shows who acted: only eRegister writes MedicationRequests or sets a Task back to `requested`, and a facility cancellation also cancels the MedicationRequest.

## Integration health (administrators and support only)

The server reads OpenHIM's management API as `portal-monitor@bonolo.local`. `scripts/setup-openhim.sh` creates the user with role `portal-monitor`, which can view channels, clients, mediators and transactions, including their bodies, and cannot change anything.

**What the page shows**
- **Status:** whether OpenHIM and the FHIR server are up (with versions), and the installed contract version (the Bonolo StructureDefinitions on the server).
- **Per client:** requests, 4xx rejections, 5xx failures and the last request, over 24 hours or 7 days.
- **CDU status publications:** the `cdu` client's PUT/PATCH on `Task`, and how many failed.
- **Recent failures:** the latest 50 failed or rejected requests, with HAPI's OperationOutcome diagnostics.
- **Channels:** each channel and which roles it allows.

Request bodies are never sent to the browser; only diagnostics are taken from response bodies.

**On a prescription's page:** the OpenHIM transactions that changed it. These are writes to its Task and MedicationRequest, plus the eRegister transaction Bundle that created it, which is found by time and confirmed by the Task location in its response.

**On the dashboard:** administrators and support also see a warning when the last 24 hours had failed or rejected requests.

**OpenHIM 8.5 quirks**
- **Passwords:** OpenHIM checks a bcrypt hash on every basic-auth request (about 2 s, during which OpenHIM stalls). The portal therefore signs in once and reuses the session cookie.
- **New users:** `POST /users` stores the password unhashed, so the setup script sets it again with `PUT`.
- **Refused requests:** requests OpenHIM refuses (wrong client credentials or channel) are not stored as transactions, so they don't appear here; see the OpenHIM logs.

**TLS:** the demo OpenHIM uses a self-signed certificate, so compose sets `OPENHIM_API_INSECURE_TLS=true`. In production, mount the CA and set `OPENHIM_API_CA_FILE` instead.

## Users (administrators only)

The Users page manages portal accounts in Keycloak through the `repository-portal-admin` service account. That account has only `view-users`, `query-users` and `manage-users`, and no realm configuration rights. On stacks whose realm was imported before this client existed, run `./scripts/setup-keycloak.sh` once; it is safe to re-run.

**What an administrator can do**
- **Add a user:** name, username, email and portal roles. The portal generates a one-time password, shows it once and never stores it. At first sign-in Keycloak makes the user choose their own password and, unless switched off, set up an authenticator app (MFA).
- **Change roles:** only the three portal roles are ever granted or removed.
- **Reset password:** a new one-time password, and the user is signed out.
- **Reset MFA:** for a lost phone. The authenticator is removed and a new one is enrolled at next sign-in.
- **Disable or enable an account:** accounts are disabled, not deleted, so history stays attributable. Disabling also ends the user's Keycloak sessions.

**Guards:** administrators cannot disable themselves or remove their own administrator role, and the last active administrator cannot be disabled or demoted.

**Audit:** every change is logged by the portal with the administrator who made it. Keycloak also records admin events, enabled by the setup script.

**Not available yet:** email invitations and self-service password reset need an SMTP server configured in Keycloak.

## Security model

- **Sessions:** after login the server sets an encrypted, HttpOnly, SameSite=Lax cookie (AES-256-GCM) holding the user's name and portal roles, valid for 8 hours. Keycloak tokens never reach the browser.
- **Session re-checks:** the server re-checks every API request against Keycloak, cached for 60 seconds per user. A disabled account is signed out and role changes apply within a minute, or immediately when made on the Users page. If Keycloak cannot be reached, the roles in the session stand.
- **CSRF:** every changing API request must carry `X-Portal-Request: 1`, which a cross-site form cannot send.
- **Roles:** `repo-admin`, `programme-manager` and `support` are Keycloak realm roles, sent in the ID token's `roles` claim. Access per feature is defined once in `server/src/roles.ts`; the UI copy in `web/src/roles.ts` only decides what to show.
- **Audit:** FHIR reads go through OpenHIM as the `portal` client, with an `X-Portal-User` header naming the person, so OpenHIM's transaction log records who viewed what.
- **Read-only:** OpenHIM only lets the `portal` client use the GET channel.

## Develop

```sh
cd server && npm install && npm test && npm run typecheck
cd web && npm install && npm run typecheck && npm run build
```

For UI work, keep the stack running and start `npm run dev` in `web/`. Vite serves on :5173 and forwards `/api` and `/auth` to the portal on :3000. Sign in once at http://localhost:3000 so the session cookie exists for `localhost`.
