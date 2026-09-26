# Signed-identity sign-in (family deployment)

OpenMAIC normally has no sign-in: each browser gets an anonymous 30-day cookie
and owns whatever it creates. This fork adds an optional sign-in mode in which
a trusted front proxy tells the app who is signing in, and the app gives every
member their own library, lets parents (admins) see everything, and lets
members share courses with each other.

Design: `docs/designs/tailscale-identity-login.md`. Review record:
`docs/plans/tailscale-identity-login.md`.

## How it works

```
browser ─https─▶ tailscale serve (root, :443)
                   │ strips forged Tailscale-User-* headers
                   ▼
           identity bridge  127.0.0.1:3001  (scripts/identity-bridge.mjs, user service)
             1. peer socket must belong to uid 0 (tailscaled)   else 403
             2. no untrusted host-network container is running  else 503
             3. drops inbound X-OpenMAIC-Identity-*
             4. Tailscale-User-* ─▶ signed X-OpenMAIC-Identity-* (HMAC-SHA256)
                   ▼
           OpenMAIC  127.0.0.1:3000  (container)
             every route verifies the signature and its age (5 minutes)
```

- Identity headers: `X-OpenMAIC-Identity-Login`, `-Name` (percent-encoded),
  `-Avatar`, `-Timestamp` (epoch seconds), `-Signature` = lower-case hex
  HMAC-SHA256 over `v1\n<login>\n<name>\n<avatar>\n<timestamp>`, keyed with
  the UTF-8 bytes of `AUTH_IDENTITY_SECRET`.
- A member's owner id and learner key is `acct_` + the first 32 hex of
  SHA-256(lower-cased login).
- Admins come from `AUTH_ADMIN_LOGINS`. They can read every course and open
  the **Family** page (`/family`): members, their courses, their quiz results.
- A course is readable by its owner, admins, and members it is shared with.
  Everyone else gets 404, the same as a missing course. Only the owner edits.
- Quiz attempts follow the account across devices. The first time a device
  signs in, its earlier anonymous attempts are merged into the account.

### Trust model

- Trusted: root, the deployment user (`clawdbot`), and members of the
  `docker` group. They can read the secret or control the containers.
- Everyone else on the host cannot obtain a signed identity: the bridge only
  serves uid-0 peers, and the app port only answers signed requests.
- A container using host networking and running as root would pass the uid
  check. The bridge watches `docker events` and refuses service (503) within
  about a second while any such container not listed in
  `BRIDGE_TRUSTED_HOST_NET` runs, and whenever it cannot tell (events stream
  down). The remaining sub-second race is accepted.

### Known residuals

- Quiz scores are graded in the browser (upstream behaviour); a member could
  submit a forged score for themselves.
- The Pi chat whiteboard keeps upstream's development-token principal
  (decision D23). A signed-in member who knows the public dev token could
  write another learner's whiteboard partition.
- Persistence asset bytes are one shared partition (upstream). Asset ids are
  unguessable and only appear inside access-controlled documents.
- Anyone who learns another device's random anonymous learner key could claim
  that device's pre-sign-in quiz attempts.
- Identity is per device: whoever is signed in to Tailscale on a device is
  that person on the site. The identity chip always shows who that is.

## Configuration

App (`.env.local`, mode 0600):

| Variable | Value |
|---|---|
| `AUTH_MODE` | `signed-header` |
| `AUTH_IDENTITY_SECRET` | ≥ 32 bytes, e.g. `openssl rand -hex 32`; identical in the bridge |
| `AUTH_ADMIN_LOGINS` | comma-separated Tailscale logins of the parents |
| `AUTH_MAX_SKEW_SECONDS` | optional, default 300 |
| `AUTH_SERVICE_TOKEN` | optional, ≥ 32 bytes: lets an external skill client (OpenClaw) call the skill API |
| `AUTH_SERVICE_OWNER_LOGIN` | required with the token: who owns classrooms the token creates |

Build (`.env` compose build args): `NEXT_PUBLIC_AUTH_MODE=signed-header` and
`NEXT_PUBLIC_PERSISTENCE=1`. `DATABASE_URL` must be set.

The app refuses to boot when the runtime `AUTH_MODE` and the build's
`NEXT_PUBLIC_AUTH_MODE` differ, when persistence is missing, when the secret is
short, when there is no admin, or together with `PERSISTENCE_SHARED_OWNER_ID`.
`PERSISTENCE_DEV_TOKEN` is no longer required (the Pi whiteboard still uses
it). Server publish/unpublish is disabled; sharing replaces it.

Bridge (`~/source/identity-bridge/.env`, mode 0600):

| Variable | Value |
|---|---|
| `AUTH_IDENTITY_SECRET` | same as the app |
| `BRIDGE_LISTEN_HOST` / `BRIDGE_LISTEN_PORT` | default `127.0.0.1` / `3001` |
| `BRIDGE_UPSTREAM` | default `http://127.0.0.1:3000` |
| `BRIDGE_TRUSTED_HOST_NET` | host-network containers you accept (normally empty) |

`BRIDGE_DOCKER_GUARD=off` and `BRIDGE_ALLOW_ANY_PEER=1` exist for development
only and log a warning.

## Cut-over (first deployment)

0. **Preflight** (app still running), once per owner pair:
   `psql "$DATABASE_URL" -v from_owner='anon:…' -v to_owner='acct_…' -f scripts/reassign-owner-preflight.sql`
   must end with `PREFLIGHT OK`. Compute `acct_…` with
   `node -e 'console.log("acct_"+require("crypto").createHash("sha256").update(process.argv[1].trim().toLowerCase()).digest("hex").slice(0,32))' parent@example.com`.
1. `docker compose stop openmaic` (the agent runner must be idle).
2. `pg_dump` to `~/backups/openmaic-<timestamp>.sql`.
3. `psql … -f scripts/reassign-owner.sql` for each pair.
4. Build and start the sign-in image
   (`docker compose up -d --build openmaic`), then install and start the bridge:
   copy `scripts/identity-bridge.mjs` to `~/source/identity-bridge/`, install
   `scripts/identity-bridge.service` as a user unit, `systemctl --user enable --now identity-bridge`.
5. `sudo tailscale serve --bg --https=443 http://127.0.0.1:3001`.
6. Post-checks:
   - `curl -s http://127.0.0.1:3001/__bridge/health` as a normal user → 403
     (non-root peer); `journalctl --user -u identity-bridge` shows the guard is ok.
   - `curl -si http://127.0.0.1:3000/api/stages` → 401 (unsigned).
   - Forged headers on the app port → 401.
   - Open the site from each member's device: the identity chip shows them,
     each moved course opens for its new owner, parents see the Family page.
7. On a failed check: `sudo tailscale serve --bg --https=443 http://127.0.0.1:3000`,
   restore the dump, run the previous image with the previous env.

## Adding a member

Invite them to the tailnet (Tailscale admin console → Users → Invite). The
free Personal plan allows three users. They open the site once from their own
signed-in device; after that they appear in share pickers and on the Family
page. Node sharing is expected to work per Tailscale's documentation but is
not yet verified here: for the first node-shared member, check that their
requests reach the bridge with a login (their identity chip shows it).

Devices tagged in Tailscale have no user identity and get the notice page.

## Troubleshooting

- Every request 401 and the log says `bad-signature`: the bridge and app
  secrets differ.
- `stale`: the host clock is off, or `AUTH_MAX_SKEW_SECONDS` is too small.
- Every request 503 from the bridge: a host-network container is running, or
  Docker is unreachable. `journalctl --user -u identity-bridge` names it.
- The notice page on a signed-in device: the device is tagged, or Serve does
  not point at the bridge (`tailscale serve status`).
