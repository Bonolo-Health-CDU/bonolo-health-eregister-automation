# Bonolo CDU ↔ eRegister prescription repository

The demo stack for exchanging ART prescriptions between **eRegister** (Bahmni at the facilities) and the **Bonolo Health Central Dispensing Unit** (CDU, Odoo). Facilities publish prescriptions to a FHIR repository; the CDU picks them up, and publishes its fulfilment status back; an admin portal shows what is happening.

```
eRegister (facilities) ──┐
                         ├──► OpenHIM :5001 ──► HAPI FHIR R4 ──► PostgreSQL
CDU (Odoo)             ──┘    (auth, channels,   (validates every write
                               audit log)          against the CDU IG)

Admin browser ──► Portal :3000 ──(read-only)──► OpenHIM :5001
                     └──► Keycloak :8180 (portal users, roles, MFA)
```

- **OpenHIM is the only door.** Every client (eRegister, CDU, registry, portal) signs in to OpenHIM, which decides per channel what it may do and logs every request.
- **The contract is enforced by HAPI.** It installs the pinned implementation guide `ls.moh.bonolo.cdu` 0.2.0 (`igs/`) and rejects Patient, MedicationRequest and Task writes that don't conform. The IG and the agreed identifiers (`NAMING.md`) live in the `bonolo-cdu-fhir-ig` repository.
- **Synthetic data only.** Never load real patient data into this stack.

## Services

| Service | URL | Purpose |
|---|---|---|
| Repository portal | http://localhost:3000 | Dashboard, prescription search, integration health, user management |
| Keycloak | http://localhost:8180/admin | Portal users and roles (`admin` / `KEYCLOAK_ADMIN_PASSWORD`) |
| OpenHIM router | http://localhost:5001/fhir | The FHIR endpoint clients and Postman use |
| OpenHIM console | http://localhost:9000 | Clients, channels, transaction log (`root@openhim.org`) |
| OpenHIM API | https://localhost:8080 | Management API (self-signed certificate) |
| HAPI FHIR, direct | http://localhost:8095 | Debugging only; bypasses OpenHIM. Open `/`, not `/fhir` |

Internal only: `hapi-db`, `keycloak-db` (PostgreSQL) and `mongo` (OpenHIM).

## Quick start

Prerequisites: Docker with Compose v2, `curl`, `jq`, `openssl`, `sha512sum`, and Node.js 18+ for running the Postman collection with `npx newman`.

```sh
docker compose up -d --build
./scripts/setup-openhim.sh      # OpenHIM clients, channels and the portal's read-only API user
./scripts/setup-keycloak.sh     # portal user-management access and login theme (safe to re-run)
```

`setup-openhim.sh` waits for HAPI to finish installing the IG (the first start takes a minute or two). Both scripts are idempotent.

Then check the whole flow with the Postman collection:

```sh
npx newman run postman/Bonolo_CDU_eRegister_FHIR_Repository.postman_collection.json --insecure
```

On fresh volumes all 38 requests and 56 assertions pass. Folders 06 and 08 *expect* failures: access refused (401) and contract rejections (422).

Open http://localhost:3000 and sign in as one of the demo users created on Keycloak's first start:

| User | Role | Can see |
|---|---|---|
| `repo.admin` | Administrator | Everything, including user management |
| `support.clerk` | Support | Dashboard, prescriptions, integration health |
| `programme.manager` | Programme manager | Dashboard only (aggregate figures, no patient data) |

Passwords are `PORTAL_DEMO_*_PASSWORD` in `.env`.

## How a prescription flows

| Step | Who | What happens on the repository |
|---|---|---|
| INT-01 Publish | eRegister | POSTs a transaction Bundle: Patient, MedicationRequest, Task (`status = requested`, owned by the CDU) |
| INT-02 Pull | CDU | Searches `Task?owner=Organization/1-LESOTHO-CDU&status=requested` and claims each Task (`accepted` / `received`) |
| INT-03 Status | CDU | Updates the Task's `status` and `businessStatus` as the prescription moves through the CDU (Status Map in the data-mapping sheet) |
| Return / resubmit | CDU, eRegister | CDU sets `rejected` / `returned-to-facility` with a reason; the facility amends the MedicationRequest and sets the Task back to `requested` |
| Cancel | eRegister | Cancels the MedicationRequest and the Task |

On the CDU side this is implemented by the `cdu_eregister` Odoo module in the `bahmni-docker` repository (`bahmni-standard/extra-odoo-addons/cdu_eregister`). Postman folders 03–04 play the CDU's part. Don't use them while Odoo's automatic sync is on, or Odoo claims the Tasks first.

### OpenHIM clients and channels

| Client | Role | May |
|---|---|---|
| `eregister` | eregister | Publish and amend prescriptions; read; reset a Task to `requested` |
| `cdu` | cdu | Update Tasks, record MedicationDispense; read |
| `registry-admin` | registry | Write reference data (Organization, Location, CodeSystem, ValueSet, ConceptMap); read |
| `portal` | portal | Read only |

Channels are defined in `openhim/channels.json`; client passwords come from `.env`. Reference data (facilities, pickup points, the CDU) is created by Postman folder 01. Record ids follow `NAMING.md`: `Organization/{facility code}`, `Location/pup-{Collect & Go reference}`.

## Repository layout

| Path | What |
|---|---|
| `docker-compose.yml` | The whole stack |
| `.env` | Demo passwords and secrets used by compose and the scripts |
| `hapi/` | Small derived HAPI image: installs the IG before validation rules are built, maps missing-profile errors to 422. See [hapi/README.md](hapi/README.md) |
| `igs/` | The pinned IG package (the contract) |
| `openhim/` | Channel definitions and console configuration |
| `keycloak/` | Realm (`bonolo-repository`: roles, clients, demo users) and the `bonolo` login theme with the Ministry of Health logo |
| `portal/` | Admin portal: Node/Fastify server and React UI. See [portal/README.md](portal/README.md) |
| `postman/` | End-to-end collection: reference data, publication, CDU pull and status, access control, contract rejections |
| `scripts/` | `setup-openhim.sh`, `setup-keycloak.sh`, `wait-for-hapi.sh` |

## Common tasks

| Task | How |
|---|---|
| Start from empty data | `docker compose down -v && docker compose up -d && ./scripts/setup-openhim.sh && ./scripts/setup-keycloak.sh`. This deletes all FHIR, OpenHIM and Keycloak data, including portal users. |
| Update the contract | Build the package in `bonolo-cdu-fhir-ig` (`./scripts/package.sh`), copy the tgz into `igs/`, update `version` and `packageUrl` in `hapi/application-bonolo.yaml`, then reset the data. |
| Rebuild HAPI after Java changes | `docker compose build hapi-fhir && docker compose up -d hapi-fhir` |
| Rebuild the portal | `docker compose up -d --build portal` |
| Portal tests | `cd portal/server && npm install && npm test` |
| Change the login theme | Edit `keycloak/themes/bonolo`, then `docker compose up -d --force-recreate keycloak`. A plain restart keeps Keycloak's gzip cache of the old files. |

## Troubleshooting

- **OpenHIM console login does nothing.** Open https://localhost:8080/heartbeat in the same browser and accept the self-signed certificate first.
- **`setup-openhim.sh` fails with a `jq` parse error.** OpenHIM's root password no longer matches `.env` (the console asks you to change it at first login). Update `OPENHIM_ROOT_PASSWORD` locally; don't commit your real password.
- **`http://localhost:8095/fhir` asks for a password.** HAPI redirects the bare `/fhir` path to its public address, which is OpenHIM. Use http://localhost:8095/ or a full resource URL.
- **A write is rejected with 412 or 422.** The payload breaks the contract. The OperationOutcome says why, and the portal's Integration health page lists recent rejections.
- **Tasks are claimed before Postman folder 03 runs.** Odoo's `cdu_eregister` sync is on; switch off *Automatic Synchronisation* in CDU › Configuration › eRegister Integration.

## Security notes

This stack is for demos and development:

- **`.env` is committed with demo secrets.** Replace them before sharing the stack with anyone, and keep real passwords out of git.
- **Self-signed certificate:** the portal skips certificate checks on the OpenHIM API (`OPENHIM_API_INSECURE_TLS`). In production, mount the CA and set `OPENHIM_API_CA_FILE`.
- **Keycloak** runs over plain HTTP on localhost. A real deployment needs HTTPS, real hostnames and an SMTP server for invitations and password reset.
