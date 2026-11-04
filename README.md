# Guard House QR Monitoring System

Pre-printed visitor passes with QR codes, issued at the guard house and scanned by office
staff on their phones. The guard house sees every pass move from *issued* to *arrived* to
*checked out* in real time.

```
Guard house                    Office (phone)                 Guard house
┌──────────────┐   pass QR    ┌──────────────┐   live update  ┌──────────────┐
│ Issue pass   │ ───────────► │ Scan + confirm│ ─────────────► │ Live board   │
│ (unused→issued)│             │ issued→arrived│               │ + checkout   │
└──────────────┘              └──────────────┘                └──────────────┘
```

## Requirements

- Node.js **22.5 or newer** (uses the built-in `node:sqlite` module). Tested on Node 24.
- No external database, no build step, no cloud account.

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000> and sign in with the seeded account:

| Username | Password   | Role  |
| -------- | ---------- | ----- |
| `admin`  | `admin123` | Admin |

The password is printed in the terminal the first time the database is created. **Change it
immediately** (Admin → Change password); a warning banner stays until you do.

To try the whole flow without creating accounts first:

```bash
SEED_DEMO=1 npm start     # Windows PowerShell: $env:SEED_DEMO="1"; npm start
```

That adds sample offices, a demo print batch, and these accounts:

| Username     | Password   | Role        |
| ------------ | ---------- | ----------- |
| `guard1`     | `guard123` | Guard       |
| `registrar1` | `office123`| Registrar   |
| `cashier1`   | `office123`| Cashier     |

## Roles

- **Guard** (`/guard`) — issues passes, watches the live board, checks visitors out.
- **Office staff** (`/scan`) — camera scanner or manual code entry; confirms that the
  visitor reached their office.
- **Admin** (`/admin`) — offices, contact persons, staff accounts, QR print batches, pass log.

## Daily procedure

1. **Print passes once.** Admin → *Pass supply* → generate a batch (say 50) → **Print**.
   The sheet is A4, 12 passes per page with cut guides. Each ticket carries only a code and
   a QR — no visitor details, because passes are printed before anyone arrives.
2. **Issue at the gate.** Guard scans or types the code, enters the visitor's name, picks
   the office and contact person (purpose optional). The pass becomes *issued*.
3. **Confirm at the office.** Staff open the app on their phone, scan the pass QR, check the
   visitor details and tap **Confirm arrival**. The guard house board updates immediately.
4. **Check out.** When the visitor leaves, the guard taps **Check out**. The pass is spent
   and cannot be reused.

A visitor who leaves without being scanned in can still be checked out — the record is
marked *departed without confirmation*.

## Printing

- Each QR contains the pass URL plus its code, e.g. `https://your-host/scan?code=GH-7K2M-9QX4`.
  Office staff can scan it with the app, and the app also accepts the bare printed code.
- **Print after setting `PUBLIC_BASE_URL`** if you use a domain. If the QR points at
  `localhost` the app still works (it reads the code out of the URL), but scanning the
  ticket with the phone's own camera app would open the wrong address.
- Cancelled or lost passes can be voided in *Admin → Pass log*; scanning a voided pass is
  refused with a clear message.

## Install on a phone (office staff)

1. Open the site in Chrome (Android) or Safari (iOS) and sign in.
2. Android: menu → **Add to Home screen**. iOS: Share → **Add to Home Screen**.
3. It launches full screen like a native app.

### Camera and HTTPS

Browsers only allow camera access on **HTTPS** or on `localhost`. On a plain
`http://192.168.x.x` address the scanner is disabled and the app shows *"Camera capture
needs HTTPS on this connection"* — staff can still type the pass code, and every other
feature works normally.

To use the camera over the network, put the app behind TLS. Two practical options:

- Run a Cloudflare Tunnel (or any reverse proxy with a certificate) in front of the app and
  set `PUBLIC_BASE_URL` to that https address before printing passes.
- Host it on a small server with a real certificate (e.g. Caddy, which provisions one
  automatically).

Behind a proxy, forwarded `https` is detected so session cookies are marked `Secure`
automatically.

## Configuration

Copy `.env.example` to `.env` and edit as needed (the file is git-ignored).

| Variable          | Default              | Purpose |
| ----------------- | -------------------- | ------- |
| `PORT`            | `3000`               | HTTP port |
| `SITE_NAME`       | `Guard House`        | Printed on passes and shown in the header |
| `APP_TZ`          | `Asia/Manila`        | Time zone used for "today" on the dashboard |
| `PUBLIC_BASE_URL` | request origin       | Address baked into printed QR codes |
| `DB_PATH`         | `data/app.db`        | SQLite database location |
| `ADMIN_PASSWORD`  | `admin123`           | Password used when the admin account is first created |
| `SEED_DEMO`       | off                  | `1` loads sample offices, passes and demo accounts |

## Data and backup

Everything lives in one SQLite file: `data/app.db` (plus `-wal`/`-shm` while running).
Stop the server, copy that file somewhere safe, and you have a full backup.

```bash
# reset everything (destroys all visits, passes and accounts)
rm -rf data/
```

## Security notes

- Passwords are hashed with scrypt; sessions are httpOnly, SameSite=Lax cookies valid for
  30 days so office phones stay signed in.
- Roles are enforced server-side on every request: office accounts can only confirm
  arrivals, guards can only issue/check out, and administration is admin-only.
- Login attempts are rate limited.
- The server has no TLS of its own — put it behind HTTPS before exposing it beyond a
  trusted network, and change the seeded password.
- Voiding a pass is permanent and auditable; every action appears in the visit activity log.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `EADDRINUSE` on start | Another process uses the port: `PORT=3001 npm start` |
| Camera button greyed out | Not HTTPS (see above); type the code instead |
| "Unknown pass" when scanning | The pass belongs to a different database/site — check the batch was printed from this install |
| Scanner library missing | `public/vendor/html5-qrcode.min.js` is vendored in the repo; restore it if deleted |
| Forgot admin password | With the server stopped, delete `data/app.db` (loses data) or insert a new admin hash manually |

## Project layout

```
src/server.js     Express routes, pass state machine, live SSE stream, print sheet
src/db.js         SQLite schema, seeding, pass-code helpers
src/session.js    Cookie sessions and role guards
src/passwords.js  scrypt hashing
public/           Guard board, scan app, admin console, styles, PWA shell
scripts/          PWA icon generator (npm run icons)
data/             SQLite database (git-ignored)
```
