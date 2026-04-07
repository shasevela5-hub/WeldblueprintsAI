# WeldBlueprints AI

WeldBlueprints AI is an Express app that generates fabrication-ready PDF blueprints, manages user accounts, and supports paid upgrades through PayPal.

## Run locally

1. Install dependencies with `npm install`.
2. Update `.env` with local or production-ready values.
3. Start the server with `npm start`.
4. Open `http://localhost:3000`.

## Required production environment variables

- `NODE_ENV=production`
- `PORT`
- `APP_ORIGIN`
- `JWT_SECRET`
- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_BASE_URL=https://api-m.paypal.com`
- `FREE_GENERATION_LIMIT=3`

## Production checklist

1. Point your domain to the server and set `APP_ORIGIN` to the final `https://...` URL.
2. Use long random values for `JWT_SECRET` and `SESSION_SECRET`.
3. Replace the admin placeholders with your real admin credentials.
4. Set your live PayPal client ID and secret.
5. Run the app behind HTTPS with Nginx, Caddy, or another reverse proxy.
6. Keep the `backups/` and `sessions/` directories writable by the app process.
7. Confirm `https://your-domain/healthz` returns a healthy JSON response.

## Deploy notes

- The pricing page now receives the PayPal client ID from the server, so it no longer relies on a hardcoded value in the HTML file.
- User, project, and custom setting data is stored in `data.json`.
- Session files are stored in `sessions/` when `SESSION_STORE=file`.

## Main pages

- `/index.html` generator
- `/login.html` auth
- `/pricing.html` upgrade
- `/settings.html` settings database
- `/dashboard.html` user dashboard
- `/admin.html` admin panel
