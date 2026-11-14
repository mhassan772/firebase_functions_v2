# Accounts page (accounts.mantooq.com)

Mantooq's own account pages, in Arabic or English (`lang=en`), served from Hosting site `mantooq-accounts`. The root redirects to `mantooq.com`.

| Path | Page |
|---|---|
| `/action` | Handler for Firebase Auth email links: password reset, email verification, email change and email-change undo. It replaces Google's page at `/__/auth/action`. |
| `/delete` | Account deletion: what is deleted and kept (shown before any sign-in, as Google Play requires), sign-in, confirmation, then the `deleteAccount` callable. Contract: `docs/ai/plans/26-11-10/web-accounts-stage-c-spec.md` in the app repository. |
| `/subscribe` | Buying Premium by card through Stripe: the plans from `getWebPlans`, the Payment Element, then `startWebPurchase` (and `finishWebPurchase` after 3D Secure). Contract: `docs/ai/plans/26-11-10/web-accounts-stage-d-spec.md` in the app repository; the callables as built are in `docs/web_subscriptions.md` here. |
| `/manage` | The web purchase from `getWebSubscription`, with cancel (in a dialog), resume, card replacement and the bank's verification of a renewal, through `manageWebSubscription`. |

`src/main.ts` routes on the path (`src/router.ts`) and loads each page as its own chunk, so `/action` downloads no sign-in, popup or functions code, and only `/subscribe` and `/manage` carry the Stripe.js loader (`src/billing/`). The sign-in view (`src/auth/signIn.ts`) renders into a container and resolves with the signed-in user; it also has the "confirm it's you" re-authentication, for later pages to reuse. `vite.config.ts` gives `/action` its own copy of the Auth SDK in the build, because a shared copy would carry the popup code into its download.

## Deploy

Run from the repository root:

```
firebase deploy --only hosting:mantooq-accounts --project mantooq-test
```

`predeploy` installs and builds this folder. Never run a bare `firebase deploy`; see the warnings in the workspace notes. The functions deploy ignores this folder (`firebase.json` → `functions.ignore`).

## How links reach this page

Firebase refuses every edit to this project's Auth templates and action URL (`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`, since 2026-11), so emails Firebase sends itself still link to its own page. The page is reached through our callables instead (`src/functions/authEmails/`): they generate the link with the Admin SDK, rewrite it to `/action`, and send the email through SES. The app uses them when the remote config kill switch `auth_emails_server` is on; turning it off is the rollback.

If Firebase ever allows the edit again, Authentication → Templates → Customize action URL → `https://accounts.mantooq.com/action` would send every app version here too.

## Email templates

`email-templates/` holds branded Arabic bodies for the console's password reset and verification templates, kept for the day the console accepts edits again. The callables render their own emails (`src/services/email/authEmailTemplates.ts`). Both use `public/email-logo.png`, served from this site.

## Design notes

- The Firebase web config comes from Hosting's `/__/firebase/init.json`, so no key is committed. The `apiKey` in the link is ignored.
- `/action` runs Auth with in-memory persistence: nothing is stored in the browser. `/delete` uses session persistence, so a reload keeps the sign-in and closing the tab ends it. A guest (anonymous) session never counts as signed in.
- On `accounts.mantooq.com`, `/delete` sets `authDomain` to the page's own host, so the Google and Apple windows name that host and Firebase's `/__/auth/` helper pages are same-origin. Elsewhere the configured domain stays.
- Fonts are self-hosted. `firebase.json` sets `no-referrer`, `no-store`, `nosniff`, HSTS and `noindex` on every path, and a Content-Security-Policy, `X-Frame-Options: DENY` and a `Permissions-Policy` per page (`/action`, `/delete`, and `/index.html` when opened directly). They are not on `**`, where they would also cover Firebase's `/__/auth/` pages and break the sign-in popup and its helper frame.
- `/action`'s policy allows only this site and the two Auth hosts, because the link's one-time code is effectively a credential. `/delete`'s adds the Google API script host for the popup helper, frames from this site for Firebase's helper frame, the europe-west2 functions host and the Firestore REST host.
- `/delete` reads `subscription_master/{uid}` once through the Firestore REST API with the user's ID token, to name a store whose subscription still renews. A failed read leaves the general store notice. There is no Firestore SDK in the page.
- Before deleting, `/delete` asks the user to confirm it is still them when the sign-in is over four minutes old (the backend allows five), and revokes the Apple token when the sign-in in this tab came from Apple. The token is kept in memory only, so after a reload it is not revoked.
- "Open Mantooq" buttons use `go.mantooq.com` app links and appear only on phones. After an email change the page shows text only, because the app confirms the change when it resumes, and a deep link would navigate away from that screen.
- Passwords need at least 8 characters, matching the app's sign-up rule.
- `/subscribe` and `/manage` sign in like `/delete`. Stripe.js comes from `@stripe/stripe-js/pure`, which adds the script only when one of them first needs it, with one instance per language; Arabic mounts the Payment Element under `dir="rtl"`.
- The Elements group is deferred: `subscription` mode for monthly and yearly and `setup` mode for a card replacement, both with `setupFutureUsage: "off_session"` (the server refuses any other token for them), and `payment` mode with no `setupFutureUsage` for lifetime. `allowedPaymentMethodTypes: ["card"]` and the Payment Element's `wallets.link: "never"` keep Link out; Apple Pay and Google Pay stay, since they are cards. The billing address is `auto`.
- The server decides every price. The page sends the total it showed; a different one comes back as a re-price with nothing charged, and the page asks again. Every press of the pay or save button, an accepted re-price included, makes a new confirmation token from the card form as it is then (`purchaseRequest` and `replaceCardRequest` in `src/billing/logic.ts`): the Payment Element does not report every edit, so a saved token could charge a card the buyer has since changed.
- The Payment Element sits in a frame that reloads, losing what was typed, if it is ever detached, so these pages update their parts in place (`Regions` in `src/billing/ui.ts`) and re-render whole only between views and on a language switch.
- Their policy is `/delete`'s, without the Firestore host, plus `https://js.stripe.com` in `script-src`, `https://js.stripe.com https://hooks.stripe.com` in `frame-src`, and `https://api.stripe.com https://fonts.googleapis.com` in `connect-src` (Stripe.js fetches the Payment Element's font stylesheet from the page). Their `Permissions-Policy` leaves `payment` allowed, for Apple Pay and Google Pay.

## Local runs

`npm run dev` reads these from `.env.development.local` (copy `.env.development.local.example`). A production build ignores them.

| Setting | Meaning |
|---|---|
| `VITE_AUTH_EMULATOR` | Auth emulator URL. Turns the emulators on; without it the page fetches `/__/firebase/init.json` like production. |
| `VITE_FIRESTORE_EMULATOR` | Firestore emulator URL, for the `subscription_master` read on `/delete`. |
| `VITE_FUNCTIONS_EMULATOR` | Functions emulator URL, for `deleteAccount`. |
| `VITE_PROJECT_ID` | Emulator project id, `demo-mantooq`. |

The Auth emulator lists generated email-link codes at `/emulator/v1/projects/demo-mantooq/oobCodes`, for trying `/action`.

### Local stack for `/delete`, `/subscribe` and `/manage`

From the repository root, `npm run emulators:accounts` builds the functions, starts Auth (9096), Firestore (8089), Functions (5004) and Storage (9196) from `firebase.accounts-test.json` on project `demo-mantooq`, seeds them, and runs until Ctrl+C. Its ports differ from the other emulator configs, so it runs alongside them. The functions emulator loads the real `deleteAccount`, and the Auth trigger `accountDeletedCleanup` runs after it. The confirmation email fails without the SES secrets; that failure is logged and does not fail the deletion. `npm run emulators:accounts:seed` resets the data while the stack runs. The start script hides this machine's Google credentials from the emulators, because a few functions in the bundle name the production project directly.

Then `npm --prefix accounts-page run dev` and open `http://localhost:5173/delete`, `/subscribe` or `/manage`.

Buying needs Stripe's sandbox keys in the gitignored `.secret.local` at the repository root, as `STRIPE_WEB_SECRET_KEY=sk_test_…` and `STRIPE_WEB_PUBLISHABLE_KEY=pk_test_…`; the functions emulator reads its secrets from there, and the start script refuses a key that is not a sandbox key. The seed writes `web_pricing/config` with sales on, tax off and every seeded account as a tester. Stripe has no Egyptian or Turkish test card, so the seed maps Saudi Arabia to the low tier and the United Arab Emirates to the reduced one. Use only Stripe's published test cards: 4242 4242 4242 4242 (US), 4000 0068 2000 0007 (Saudi Arabia), 4000 0078 4000 0001 (UAE), 4000 0027 6000 3184 (3D Secure), 4000 0000 0000 0002 (declined).

Seeded accounts (`scripts/emulator/seed-accounts.mjs`), all with the password `mantooq-accounts-test`:

| Email | What it has |
|---|---|
| `plain@example.com` | Only a `users` document |
| `apple-renewing@example.com` | A renewing App Store row in `subscription_master`, so `/delete` names the App Store |
| `with-data@example.com` | Documents in several collections, a payment request (anonymised on deletion) and an upload in Storage |
| `sa-buyer@example.com` | A Saudi App Store storefront, so `/subscribe` shows the low tier and a US card is re-priced |
| `ae-buyer@example.com` | An Emirati App Store storefront, so `/subscribe` shows the reduced tier |

Google and Apple sign-in work through the Auth emulator's own sign-in window, which creates a test user.

## Tests

`npm test` runs the unit tests in `test/` (Vitest): routing, the `subscription_master` parsing, error mapping, the sign-in age check and the deletion failure handling; `test/billing.test.ts` covers the purchase pages' decisions (plans offered, totals, Elements options, refusal mapping, the request each attempt sends, `/manage` actions and money and date formatting).
