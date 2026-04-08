# WeldBlueprints AI

WeldBlueprints AI is an Express app that generates fabrication-ready PDF blueprints, manages user accounts, and supports paid upgrades through PayPal.

## Quick start

1. Install dependencies: `npm install`
2. Copy env template: `cp .env.example .env` (or create `.env` manually on Windows)
3. Update `.env` values for your environment
4. Start the app: `npm start`
5. Open `http://localhost:3000`

## Scripts

- `npm start` - run the production server
- `npm run dev` - run server locally
- `npm run smoke` - launch smoke tests (isolated temp data paths)
- `npm test` - alias for smoke tests

## Environment variables

### Required for production

- `NODE_ENV=production`
- `PORT`
- `APP_ORIGIN` (final `https://...` URL)
- `JWT_SECRET`
- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_BASE_URL=https://api-m.paypal.com`

### Runtime storage paths (optional, recommended)

- `DATA_FILE` (default: `./data.json`)
- `ANALYTICS_FILE` (default: `./analytics.json`)
- `BACKUP_DIR` (default: `./backups`)
- `SESSION_DIR` (default: `./sessions`)

You can set these to absolute paths so production/staging/test runs do not share the same data files.

## Launch checklist

1. Configure DNS and set `APP_ORIGIN` to your final HTTPS domain.
2. Set strong random values for `JWT_SECRET` and `SESSION_SECRET`.
3. Replace default admin credentials.
4. Set live PayPal credentials and production PayPal base URL.
5. Run behind HTTPS reverse proxy (Nginx, Caddy, Cloudflare Tunnel, etc.).
6. Ensure storage paths are writable by the app process.
7. Run `npm test` and confirm smoke test passes.
8. Confirm `https://your-domain/healthz` returns healthy JSON.

## Security notes

- Sensitive runtime files (`data.json`, analytics, backups, sessions, server source, env files) are blocked from public static access.
- Security headers are applied for browser hardening.
- In production, `trust proxy` is enabled for secure cookie behavior behind reverse proxies.

## Main pages

- `/index.html` generator
- `/login.html` auth
- `/pricing.html` upgrade
- `/settings.html` settings database
- `/dashboard.html` user dashboard
- `/admin.html` admin panel
