# Roleplay Coaster

Jewellery-sales roleplay practice app. Google Sheet = database, one Cloudflare Worker = backend, plain HTML = frontend.

## Files
`public/index.html` (frontend) · `src/worker.js` (backend) · `wrangler.jsonc` (config)

## Commands
```bash
npm i -D wrangler          # once
npx wrangler dev           # local test (reads secrets from .dev.vars)
npx wrangler deploy        # manual deploy
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL   # repeat for each secret below
```
Auto-deploy: Cloudflare dashboard > Workers > your Worker > Settings > Builds > connect the GitHub repo
(deploy command `npx wrangler deploy`). Every push to the main branch then deploys.

## Secrets
| Name | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` from the service-account JSON |
| `GOOGLE_PRIVATE_KEY` | `private_key` from the JSON (keep the `\n`s) |
| `SHEET_ID` | the ID in the Google Sheet URL |
| `MANAGER_PASSWORD` | the manager's password |
| `TOKEN_SECRET` | any long random string |

Share the Google Sheet with the service-account email as **Editor**. For local dev, put the same five
`NAME="value"` lines in a `.dev.vars` file (already git-ignored).

## Known limitation
The customer card is **honour system**: anyone who knows a session ID can open `#/customer/<ID>` and confirm
to see the card. The confirm step only stops accidental peeking, not a determined one.
