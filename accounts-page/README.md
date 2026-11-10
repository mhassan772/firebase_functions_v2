# Accounts page (accounts.mantooq.com)

Mantooq's own handler for Firebase Auth email links: password reset, email verification, email change and email-change undo, in Arabic or English (`lang=en`). It replaces Google's page at `/__/auth/action`.

Served from Hosting site `mantooq-accounts` at `https://accounts.mantooq.com/action`. The root redirects to `mantooq.com`.

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
- Auth runs with in-memory persistence: nothing is stored in the browser.
- No third-party requests. Fonts are self-hosted, and `firebase.json` sets a strict CSP, `no-referrer`, `no-store` and `noindex`, because the link's one-time code is effectively a credential.
- "Open Mantooq" buttons use `go.mantooq.com` app links and appear only on phones. After an email change the page shows text only, because the app confirms the change when it resumes, and a deep link would navigate away from that screen.
- Passwords need at least 8 characters, matching the app's sign-up rule.

## Local runs

`npm run dev` with an `.env.development.local` that sets `VITE_AUTH_EMULATOR` (for example `http://127.0.0.1:9199`) and `VITE_PROJECT_ID=demo-mantooq`. The page then talks to an Auth emulator, which lists generated codes at `/emulator/v1/projects/demo-mantooq/oobCodes`.
