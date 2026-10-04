# Guest downloads for email transfers

## What exists today

- Sending to an email with no account already creates a transfer in the `PENDING_RECIPIENT_SIGNUP` state. It stores a `PENDING#<email>` row and queues an `EMAIL` job. This happens in two places: `domain.ts:1484` and the background path at `workflows.ts:266`.
- `claimPending` (`domain.ts:1507`) moves the transfer into the recipient's account once they sign up with that verified email.
- Transfers expire after 30 days (`domain.ts:1472`).
- Transfer file downloads already return a presigned R2 URL, but only to an account that has accepted the transfer (`domain.ts:1098`).
- `sendEmail(to, sender)` in `runtime.ts:75` sends one hard-coded invite text, which says "Files are never available through public links." It only works when `EMAIL_FROM` is set.
- Rate limiting (`api.ts:171`) counts per minute. Public routes are only limited for `/v1/auth/*`.

## How it will work

1. A sender sends files to an email with no harbor0 account. The recipient gets an email with a unique link: `https://<web>/receive#<token>`.
2. The page shows the sender's name and verified email, the number of files, the total size and the expiry date. Next to it is an "Email me a code" button.
3. Clicking the button sends a 6-digit code to that address. The recipient enters the code and gets a guest pass that lasts 24 hours or until the transfer expires, whichever is first.
4. They download each file through the existing presigned R2 URLs.
5. A "Save to your own harbor0 (50 GB free)" button leads to sign-up, and `claimPending` then moves the transfer into their new account.

## Phase 1: Set up email

- SES: request production access, verify the sending domain, and set up DKIM, SPF and DMARC. Add a configuration set that sends bounces and complaints through SNS into a suppression list. Build all of this in CDK (`infra/app.ts`).
- Change `sendEmail` to take a template name and parameters instead of `(to, sender)`. Templates, each with an HTML and a plain-text version:
  - `TRANSFER_INVITE`: shows the sender's display name and verified email, file count, total size, expiry date, link, and a "Report this" link. No custom message from the sender.
  - `TRANSFER_CODE`: the code, a note that it expires in 10 minutes, and "If you didn't request this, ignore it."
- Remove the old text that says files are never available by link.
- Local development: in `local.ts`, write emails to the console instead of sending them.
- Staging: SES sandbox mode with verified test addresses is enough.

## Phase 2: Data model (single table)

Only hashes of tokens and codes are stored, never the raw values.

| Row (pk / sk) | Fields | TTL |
| --- | --- | --- |
| `GUESTLINK#<sha256(token)>` / `LINK` | `transferId`, `email`, `createdAt`, `revokedAt` | transfer expiry |
| `TRANSFER#<id>` / `GUESTLINK` | `linkHash` (for revoking or replacing the link) | transfer expiry |
| `GUESTLINK#<hash>` / `CODE` | `codeHash` (HMAC with a server secret), `expiresAt` (+10 min), `attempts` | 10 min |
| `GUESTGRANT#<sha256(grant)>` / `GRANT` | `transferId`, `email`, `expiresAt = min(24 h, transfer expiry)` | same |
| Transfer (existing row) | add `guestDownloads` and `lastGuestDownloadAt` | — |

- The link token is 32 random bytes, encoded as base64url.
- The transfer keeps the `PENDING_RECIPIENT_SIGNUP` state, so no new state is needed.

## Phase 3: Backend

When a transfer is created (both paths: `domain.ts:1484` and `workflows.ts:266`):

- Create the link token, write the link rows, and queue `TRANSFER_INVITE` with the link.
- Limit how many new email addresses a sender can reach per day. Add a daily version of `rateLimit`. As a starting point: 20 new addresses per day, 5 per day for accounts younger than 7 days. Return a clear error when the limit is hit.

New public routes (`public: true`):

| Route | Does | Limits |
| --- | --- | --- |
| `POST /v1/guest/transfers/open {token}` | Summary: sender name and verified email, file count, total size, expiry date, masked recipient email (`a•••@gmail.com`). No file names before verification. | per IP and per token |
| `POST /v1/guest/transfers/code {token}` | Creates and emails a code, replacing any previous code | 1 per 60 s and 5 per hour per link; per IP |
| `POST /v1/guest/transfers/verify {token, code}` | Checks the code and returns a guest pass. After 5 wrong attempts the code stops working. | per IP |
| `GET /v1/guest/transfers/items` | List of files (reuses the `transferItems` logic) | guest pass |
| `POST /v1/guest/transfers/download {entryId}` | Returns a presigned URL. Single files only; no ZIP worker, to avoid AWS egress. | guest pass, per IP |

- How the guest pass is sent: in an `X-Harbor-Guest` header, with the browser keeping it in `sessionStorage`. Avoid cookies, because the web app is a static export calling a separate API.
- Extend `route()` in `api.ts` so public guest routes get IP-based rate limits, using API Gateway's source IP.
- Share the download code. Move the transfer branch of `download()` (`domain.ts:1098`) into a helper used by both the account path and the guest path. On a guest download, increment `guestDownloads`, and on the first download notify the sender ("alice@… downloaded your files").
- Every guest route checks: the link isn't revoked, the transfer is still `PENDING_RECIPIENT_SIGNUP`, and it hasn't expired.
- When the sender cancels, or the `TRANSFER_EXPIRE` job runs, delete the link rows.
- When `claimPending` runs, revoke the guest link and have the page say "Sign in to view these files."
- Optional: `POST /v1/transfers/:id/resend-invite` replaces the token, revokes the old link and emails the new one.
- Contracts: add the schemas in `packages/contracts`, then regenerate `docs/openapi.json` and `generated.ts`. CI fails if the OpenAPI output is out of date.

## Phase 4: Web pages

- New `/receive` page: the token goes in the URL fragment (after `#`), so it never reaches CloudFront or S3 logs or Referer headers, and the page works with the static export. The page goes through these screens:
  1. Loading
  2. Summary with the "Email me a code" button
  3. Code entry: 6 digits, `autocomplete="one-time-code"`, pasting allowed, a resend countdown
  4. File list with a download button per file
  5. Final states: expired, cancelled, already claimed ("Sign in"), link not found
- Sign-up prompt on the file list screen, with the email pre-filled.
- Sender side: the transfer row shows "Emailed alice@… · downloaded 2×", and the send dialog says "They'll get an email with a secure link."
- Make the same copy change on desktop, iOS and Android. The guest page itself is web-only.
- Update `scripts/transfer-layout-check.ts`.

## Phase 5: Admin console and abuse controls

- Admin console: list guest links per sender, revoke a link, show daily send counts, and show reports from the "Report this" link. Record actions in the audit log.
- Automatic limits: if a sender's bounce or complaint rate is high, pause their sending to email addresses.
- Later: serve guest downloads from a separate registered domain, so a flagged file can't get harbor0.com flagged.

## Phase 6: Tests and rollout

Backend tests:

- Only hashes are stored.
- Codes expire and lock after 5 attempts.
- A new code replaces the old one.
- Guest passes expire.
- Cancelling or expiring a transfer revokes the link.
- A claimed transfer blocks guest access.
- Daily send limits apply.
- Folder transfers return only file entries.

End-to-end test against local MinIO with console emails: send → open → code → download → sign up → transfer claimed.

Rollout: deploy to staging first, run the end-to-end flow with SES sandbox addresses, then switch production SES out of sandbox and deploy.

## Open decisions

- Guest pass length: 24 hours, or until the transfer expires?
- Daily limits: 20 per day, and 5 for new accounts? Lower during the beta?
- File names before the code: hidden (safer) or shown (more convincing)?
- After the recipient signs up, should the guest link keep working, or switch to "sign in"?
