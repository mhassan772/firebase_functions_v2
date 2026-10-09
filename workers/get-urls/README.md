# getUrls Worker

A Cloudflare Worker that serves `getUrls` for users who cannot reach Google. Its request and responses match the Firebase `getUrls` function, and like it, it only reads Firestore. Both share `src/shared/getUrlsCore.ts`, so a change to the contract goes there.

## Differences from the Firebase function

- **Expired ID tokens.** A token is accepted after it expires, for as long as its account is not deleted, disabled or revoked, because users who cannot reach Google cannot refresh it. Google's signing keys are kept in KV with no expiry so old tokens can still be verified.
- **Disabled and revoked accounts.** Every request looks up the account, and a disabled account or revoked sessions get a 401.
- **Requests.** POST only. A body that is not JSON gets a 400.

## One-time setup

1. **Service account.** Create a dedicated service account in `mantooq-test` with the roles Cloud Datastore User and Firebase Authentication Viewer, and create a JSON key for it.
2. **Secret.** Run `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT` and paste the whole key JSON.
3. **KV namespace.** Run `npx wrangler kv namespace create GOOGLE_KEYS` and put the returned id in `wrangler.toml`.
4. **Domain.** Add a custom domain under `[[routes]]` in `wrangler.toml`, with `custom_domain = true`. `workers.dev` is turned off, because some ISPs block it.

## Checks and deploy

- `npm test` runs the unit tests and `npm run typecheck` runs the type check.
- `npm run build` bundles the Worker into `dist/` without deploying it.
- `npx wrangler deploy` deploys it. The cron trigger fills KV with Google's signing keys within six hours. Until then, the first request that needs a key fetches the keys itself.
