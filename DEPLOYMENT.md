# Deploying to a server

How to run the prescription repository (OpenHIM, HAPI FHIR, Keycloak and the portal) on its own Linux server. The CDU's Odoo stays on the Bahmni server and connects to this one as a client, like eRegister.

## What runs where

| Public address | Service | Used by |
|---|---|---|
| `https://cloud.bonolohealth.gov.ls/fhir` | OpenHIM router, then HAPI FHIR | eRegister (facilities), the CDU (Odoo on the Bahmni server) |
| `https://portal.bonolohealth.gov.ls` | Repository portal | MoH and CDU staff |
| `https://auth.bonolohealth.gov.ls` | Keycloak, login pages only | portal users' browsers |

```
Internet ──► :443 Caddy (TLS, Let's Encrypt) ──► openhim-core:5001 ──► hapi-fhir ──► hapi-db
                 │                            ──► portal:3000
                 └───────────────────────────── ► keycloak:8080 (/realms, /resources only)

SSH tunnel (admins) ──► 127.0.0.1: OpenHIM console :9000 and API :8080, Keycloak admin :8180,
                                    HAPI direct :8095, portal :3000, router :5001
```

Only Caddy listens on the network (ports 80 and 443). Everything else listens on `127.0.0.1` only. Docker publishes ports past `ufw`, so binding to `127.0.0.1` is what keeps them private. The Keycloak admin console and the `master` realm are never published.

The server settings live in [docker-compose.prod.yml](docker-compose.prod.yml) and [caddy/Caddyfile](caddy/Caddyfile). The server's `.env` selects them through `COMPOSE_FILE`, so plain `docker compose …` commands and the scripts pick them up.

## Before you start

- **DNS:** all three names resolve to the server. Check with `dig +short portal.bonolohealth.gov.ls` and the same for the other two.
- **Ports 80 and 443 reachable from the internet.** Let's Encrypt needs this to issue the certificates. If the server is only reachable inside the government network, see [Certificates without Let's Encrypt](#certificates-without-lets-encrypt).
- **An e-mail address** for certificate expiry notices, for example a shared operations mailbox.
- **Real or synthetic data?** Before real patient data arrives, work through the [go-live checklist](#go-live-checklist).
- **Server:** Ubuntu 24.04 LTS. 4 vCPU, 8 GB RAM and 100 GB SSD are a sensible start.

## 1. Prepare the server

As a user with `sudo`:

```sh
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git curl jq openssl unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades      # security updates install themselves
timedatectl                                           # "System clock synchronized: yes"
```

**SSH:** allow keys only. In `/etc/ssh/sshd_config` set `PasswordAuthentication no` and `PermitRootLogin no`, then run `sudo systemctl restart ssh`. Check that key login works in a second session before you close the first.

**Firewall:**

```sh
sudo ufw allow OpenSSH          # better: sudo ufw allow from <office IP> to any port 22
sudo ufw allow 80/tcp
sudo ufw allow 443
sudo ufw enable
```

**Docker** (from Docker's own repository; Ubuntu's `docker.io` package is too old for the compose file):

```sh
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"                       # log out and in again
docker compose version                                # 2.24 or newer
```

**Log rotation**, or container logs eventually fill the disk. Create `/etc/docker/daemon.json`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
```

Then run `sudo systemctl restart docker`.

## 2. Install the stack

```sh
sudo mkdir -p /opt/cdu-fhir-repo && sudo chown "$USER" /opt/cdu-fhir-repo
git clone https://github.com/Bonolo-Health-CDU/bonolo-health-eregister-automation.git /opt/cdu-fhir-repo
cd /opt/cdu-fhir-repo
./scripts/new-env.sh ops@bonolohealth.gov.ls          # the e-mail for certificate notices
```

If the repository is private, clone it with a read-only deploy key. Generate one on the server with `ssh-keygen`, add the public key under the GitHub repository's *Settings › Deploy keys*, and clone with the `git@github.com:…` address.

[`new-env.sh`](scripts/new-env.sh) writes `.env`, readable only by you. It contains:
- a fresh random value for every password and secret,
- the three hostnames,
- `COMPOSE_FILE`, which selects the server settings.

It never overwrites an existing `.env`. **Don't copy `.env.example` on a server.** If the stack is started even once without the server settings, Keycloak imports the realm with `localhost` addresses, and the portal login will fail.

Keep a copy of `.env` somewhere safe, such as the team's password manager. A restore needs it.

Start everything. The first build takes a few minutes, and HAPI needs another minute or two to install the implementation guide:

```sh
docker compose up -d --build
./scripts/setup-openhim.sh      # OpenHIM clients, channels, the portal's read-only API user
./scripts/setup-keycloak.sh     # portal user management, login theme, admin console address
docker compose ps               # every service Up; most report (healthy)
```

Caddy requests the certificates as soon as it starts. Watch it with `docker compose logs -f caddy`. Look for `certificate obtained successfully` for each of the three names.

## 3. Check it from outside

From your own computer:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://cloud.bonolohealth.gov.ls/fhir/metadata                  # 401: OpenHIM wants credentials
curl -s -o /dev/null -w '%{http_code}\n' -u cdu:<CDU_PASSWORD> https://cloud.bonolohealth.gov.ls/fhir/metadata   # 200
curl -s https://auth.bonolohealth.gov.ls/realms/bonolo-repository/.well-known/openid-configuration | jq -r .issuer
                                                                     # https://auth.bonolohealth.gov.ls/realms/bonolo-repository
curl -s -o /dev/null -w '%{http_code}\n' https://auth.bonolohealth.gov.ls/admin/                          # 404: admin console not published
curl -s https://portal.bonolohealth.gov.ls/healthz                                                         # {"ok":true}
```

Passwords are in the server's `.env`, for example `grep ^CDU_PASSWORD /opt/cdu-fhir-repo/.env`.

## 4. Admin access through an SSH tunnel

The admin tools listen only on the server itself. Open a tunnel from your computer:

```sh
ssh -N -L 9000:127.0.0.1:9000 -L 8080:127.0.0.1:8080 -L 8180:127.0.0.1:8180 <you>@cloud.bonolohealth.gov.ls
```

Leave it running, and open these on your computer:

| Address | What | Sign in as |
|---|---|---|
| https://localhost:8080/heartbeat | OpenHIM API. Open it first and accept the self-signed certificate, or the console can't log in | — |
| http://localhost:9000 | OpenHIM console | `root@openhim.org` |
| http://localhost:8180/admin | Keycloak admin console | `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` from `.env` |

### First sign-ins

1. **OpenHIM.** Sign in as `root@openhim.org` with OpenHIM's default password, `openhim-password`. The console makes you choose a new one. Put the new password in `OPENHIM_ROOT_PASSWORD` in the server's `.env`, because `setup-openhim.sh` uses it.
2. **Keycloak.** The `admin` account created on first start is temporary.
   1. In the `master` realm, create your own administrator: *Users › Add user*.
   2. Set a password (*Credentials*) and assign the realm role `admin` (*Role mapping*).
   3. Sign in as the new administrator and delete the temporary `admin`.
   4. Put the new user name and password in `KEYCLOAK_ADMIN_USER` and `KEYCLOAK_ADMIN_PASSWORD` in `.env`, because `setup-keycloak.sh` signs in with them.
3. **Portal users.**
   1. Sign in at https://portal.bonolohealth.gov.ls as `repo.admin`, with `PORTAL_DEMO_ADMIN_PASSWORD` from `.env`.
   2. On the *Users* page, create a named account for each person, with *Require MFA* ticked. The portal shows a temporary password; give it to the person in person or by phone, not by e-mail. They choose their own password and set up an authenticator app at first sign-in.
   3. Once your own administrator account works, disable the three demo accounts: `repo.admin`, `support.clerk` and `programme.manager`.

   Self-service password reset is switched off, so no mail server is needed. An administrator resets a password or MFA from the *Users* page.

## 5. Reference data

The repository needs the CDU, the facilities and the pickup points before prescriptions can flow. Postman folder 01 loads the CDU (`1-LESOTHO-CDU`), two facilities (A2681, D5011) and their pickup points. Run it on the server against the router:

```sh
cd /opt/cdu-fhir-repo
docker run --rm --network host -v "$PWD/postman:/etc/newman:ro" postman/newman:6-alpine \
  run Bonolo_CDU_eRegister_FHIR_Repository.postman_collection.json \
  --folder "00 Health check" --folder "01 Reference data (registry-admin)" --folder "06 Access control (expected failures)" \
  --env-var base=http://localhost:5001/fhir \
  --env-var registryPassword="$(grep ^REGISTRY_PASSWORD .env | cut -d= -f2)" \
  --env-var eregisterPassword="$(grep ^EREGISTER_PASSWORD .env | cut -d= -f2)" \
  --env-var cduPassword="$(grep ^CDU_PASSWORD .env | cut -d= -f2)"
```

All 11 assertions should pass. Folder 06 checks the access rules: wrong or missing credentials, and clients trying what they may not do, must all be refused.

Load the full facility list and every pickup point before eRegister goes live, as the `registry-admin` client, following the ids in `NAMING.md`.

**Don't run folders 02–05, 07 or 09 on a server that holds real data.** They create test patients and prescriptions.

## 6. Connect the CDU (Odoo on the Bahmni server)

1. From the Bahmni server, check it can reach the repository:
   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -u cdu:<CDU_PASSWORD> https://cloud.bonolohealth.gov.ls/fhir/metadata   # 200
   ```
2. In Odoo, go to *CDU › Configuration › eRegister Integration* and set:

   | Setting | Value |
   |---|---|
   | FHIR Base URL (OpenHIM) | `https://cloud.bonolohealth.gov.ls/fhir` |
   | OpenHIM Client ID | `cdu` |
   | OpenHIM Client Password | `CDU_PASSWORD` from the repository server's `.env` |
   | CDU Organization ID | `1-LESOTHO-CDU` |

3. Click **Test Connection**, then **Pull Prescriptions Now**. The EMR Sync dot next to your name turns green.

## 7. Connect eRegister

Give the eRegister team:
- the address `https://cloud.bonolohealth.gov.ls/fhir`,
- the client ID `eregister`,
- `EREGISTER_PASSWORD`, sent through a secure channel.

Their first synthetic prescription should appear on the portal's dashboard and, within two minutes, in Odoo.

## 8. Backups

[`backup.sh`](scripts/backup.sh) dumps the FHIR and Keycloak databases and OpenHIM's MongoDB into a dated folder, and removes folders older than 14 days.

```sh
sudo mkdir -p /var/backups/cdu-fhir-repo && sudo chown "$USER" /var/backups/cdu-fhir-repo
cd /opt/cdu-fhir-repo && ./scripts/backup.sh          # try it once by hand
crontab -e
```

Add this line to the crontab (it runs every night at 01:30):

```
30 1 * * * cd /opt/cdu-fhir-repo && ./scripts/backup.sh >> /var/backups/cdu-fhir-repo/backup.log 2>&1
```

A backup that stays on the same server doesn't survive losing the server. Copy `/var/backups/cdu-fhir-repo` to another machine every night, for example with `rsync` over SSH to the Bahmni server or a storage server.

### Restoring

Use the same `.env` the backup was made with:

```sh
cd /opt/cdu-fhir-repo
B=/var/backups/cdu-fhir-repo/<date>
docker compose stop caddy portal keycloak hapi-fhir openhim-core openhim-console
docker compose exec -T hapi-db pg_restore -U hapi -d hapi --clean --if-exists --no-owner < "$B/hapi.dump"
docker compose exec -T keycloak-db pg_restore -U keycloak -d keycloak --clean --if-exists --no-owner < "$B/keycloak.dump"
docker compose exec -T mongo mongorestore --quiet --archive --gzip --drop < "$B/openhim.archive.gz"
docker compose up -d
```

Practise a restore once before go-live, for example on a spare server.

## 9. Updating

```sh
cd /opt/cdu-fhir-repo
./scripts/backup.sh
git pull
docker compose up -d --build
./scripts/setup-openhim.sh      # re-applies channels and clients; safe to re-run
./scripts/setup-keycloak.sh
```

Keycloak imports `keycloak/bonolo-repository-realm.json` only on its very first start. Later changes to that file have to be made in the admin console.

## Troubleshooting

- **No certificate (browser warning, or Caddy logs `challenge failed`).** Check the following, then run `docker compose restart caddy`:
  - DNS points at this server.
  - Ports 80 and 443 are open from the internet, in `ufw` and in any firewall in front of the server.
  - If the `bonolohealth.gov.ls` zone has CAA records, one allows `letsencrypt.org`.
- **502 from Caddy.** The service behind it isn't running. Check with `docker compose ps` and `docker compose logs <service>`.
- **Portal login fails with "Invalid parameter: redirect_uri".** Keycloak imported the realm without the server settings. Before go-live the simplest fix is to start Keycloak afresh:
  ```sh
  docker compose stop keycloak && docker compose rm -f keycloak
  docker volume rm cdu-fhir-repo_keycloak-db-data
  docker compose up -d && ./scripts/setup-keycloak.sh
  ```
  This deletes all portal users.
- **OpenHIM console login does nothing.** Open https://localhost:8080/heartbeat through the tunnel first and accept the certificate.
- **`setup-openhim.sh` fails with a `jq` error.** `OPENHIM_ROOT_PASSWORD` in `.env` doesn't match the password you chose in the console.

### Certificates without Let's Encrypt

If the server can't be reached from the internet, ask for certificates for the three names, or one certificate covering all three.
1. Put the certificate and key files in `caddy/certs/` on the server.
2. Mount that folder in the `caddy` service: `./caddy/certs:/etc/caddy/certs:ro`.
3. Add `tls /etc/caddy/certs/<certificate>.pem /etc/caddy/certs/<key>.pem` inside each of the three site blocks in `caddy/Caddyfile`.

## Go-live checklist

Before the repository holds real patient data:

- [ ] OpenHIM root password changed, and the new one in `.env`
- [ ] Temporary Keycloak `admin` replaced by a named administrator
- [ ] Named portal accounts with MFA; the demo accounts `repo.admin`, `support.clerk` and `programme.manager` disabled
- [ ] Only ports 22 (ideally from known addresses), 80 and 443 open; SSH keys only
- [ ] Unattended security upgrades on
- [ ] Nightly backups running and copied off the server; a restore has been practised
- [ ] A copy of `.env` kept safely away from the server
- [ ] Full facility and pickup-point reference data loaded
- [ ] No test data from Postman folders 02–09 on the server
