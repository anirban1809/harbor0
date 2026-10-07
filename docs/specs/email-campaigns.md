# Email campaigns in the admin console

## Why

Staff need to tell users about important changes, such as pricing and quota changes, terms, new apps and incidents. Today every email is triggered by an event and goes to one account. There is no way to write a message once and send it to everyone or to a chosen set of accounts, and no way to schedule one.

Scope: a **Campaigns** section in the admin console with three parts:

- **Templates:** reusable, branded emails.
- **Groups:** named lists of accounts that staff create and maintain by hand.
- **Campaigns:** one send of a template to an audience, either now or at a scheduled time.

Not in scope for v1: automated drip or lifecycle sequences such as "7 days after sign-up", A/B tests, and open or click tracking.

## What exists today

- **Email layout:** `renderEmail()` (`apps/backend/src/emails.ts:36`) builds the branded table layout. `composeEmail()` (`:470`) maps the `Email` union (`:89`) to `{subject, html, text}`.
- **Outbox:** `queueEmail()` (`domain.ts:204`) writes a `JOB` row of type `EMAIL`. `runJobs()` (`domain.ts:2942`) runs every minute from the `MaintenanceSchedule` rule (`infra/app.ts:483`). Each run handles at most 50 due jobs within a 210 s deadline. Failed jobs back off from 60 s up to 1 day. Jobs that are not finished re-queue themselves with `dueAt` (as `ARCHIVE_BUILD` and `TRASH_EMPTY` do).
- **SES:** `sendEmail()` (`runtime.ts:80`) calls SESv2 `SendEmail` with one recipient per call and uses the `MAIL_CONFIGURATION_SET`. The configuration set forwards bounce and complaint events to EventBridge, but only into a log group. Nothing suppresses those addresses.
- **Missing pieces:**
  - **Unsubscribe:** there are no email preferences, unsubscribe links or `List-Unsubscribe` headers anywhere.
  - **Rate limiting:** there is no SES rate handling.
- **Admin console:**
  - Roles are SUPPORT and ADMIN (`packages/contracts/src/admin.ts:9`), and permissions are checked with `guard()` (`admin/api.ts:241`).
  - Changes are written together with an audit row (`admin/service.ts:74`), require a `reason`, and use `expectedUpdatedAt` for optimistic concurrency.
  - The flags page (`apps/admin/app/flags/page.tsx`) is the pattern for list and editor pages.
  - The admin API is not part of `npm run openapi`.
- **Possible recipient sources:**
  - Accounts: `directory.all()` together with `scanProfiles()`.
  - Beta: invites, `BETA_EMAIL` test entries, and the `BETA_WAITLIST` (`beta.ts`).
  - Flag allowlists and rollout buckets (`flags.ts`).
  - Account state: suspended, deleted, quota, and storage used.

## How it will work

1. **Templates.** An admin opens Campaigns → Templates → New. They give it a name, a category (*Product updates* or *Service notices*), a subject, and a Markdown body with variables such as `{{name}}`, `{{username}}` and `{{quota}}`. The preview on the right uses the real backend renderer, so it matches what users receive. They save it.
2. **Groups.** Under Groups → New, they name the group (e.g. "Android testers", "Early supporters") and add accounts: search and pick from the users table, or paste a list of emails or usernames. Pasted entries that don't match an account are listed back and not added. Accounts can also be added to or removed from groups from a user's page. A group is just its members. There are no predefined or rule-based groups.
3. **Campaigns.** Under Campaigns → New, they:
   - pick a template;
   - add recipients from any mix of groups and individual accounts;
   - see the final count after duplicates, unsubscribed and suppressed addresses are removed;
   - send a test to themselves;
   - choose **Send now** or **Schedule** (date, time and timezone);
   - confirm with a reason. The dialog repeats the recipient count.
4. Until sending starts, the campaign can be edited or cancelled. While it sends, the campaign page shows progress: sent, skipped and failed counts, with a per-recipient list.
5. A user who receives a *Product updates* email can unsubscribe with one click, from the email link or the mail app's own unsubscribe button. They can turn it back on in web Settings → Notifications. *Service notices*, such as terms, pricing or security emails, cannot be unsubscribed from. The template editor makes this clear.

## Data

Code: `apps/backend/src/campaigns.ts` (rows, eligibility, sending), `apps/backend/src/campaign-content.ts` (Markdown and variables), `apps/backend/src/admin/campaigns.ts` (console operations), contracts in `packages/contracts/src/campaigns.ts`.

| Row (pk / sk) | Fields |
| --- | --- |
| `EMAIL_TEMPLATE` / `<id>` | name, category `PRODUCT`·`SERVICE`, subject, preheader, markdown, created/updated at and by |
| `EMAIL_GROUP` / `<id>` | name, description, memberCount, created/updated at and by |
| `EMAIL_GROUP#<id>` / `MEMBER#<userId>` | userId, email and name when added, addedAt, addedBy |
| `CAMPAIGN` / `<id>` | name, templateId, templateName, audience {groupIds, userIds}, state, content (template snapshot, set when scheduled), scheduledAt/By, startedAt, finishedAt, counts {total, pending, sent, skipped, failed}, resolvedAt, cursor, leaseUntil |
| `CAMPAIGN#<id>` / `RCPT#<userId>` | userId, email, name, status `PENDING`·`SENT`·`SKIPPED`·`FAILED`, reason, error, at |
| `JOB` / `CAMPAIGN#<id>` | the `CAMPAIGN_SEND` job, due at `scheduledAt` |
| `USER#<id>` / `PROFILE` | `emailPreferences: { productUpdates: boolean }`. A missing field means `true`. |
| `EMAIL_SUPPRESSION` / `<normalized email>` | source `BOUNCE`·`COMPLAINT`, at, messageId |

- A campaign copies its template when it is scheduled. Editing the template later does not change a campaign that is already queued.
- Group membership is read when sending starts, so members added or removed before then are included or left out.
- **Everyone** (id `everyone`) is a built-in group with no stored rows. When a campaign resolves it, it scans every account profile, so accounts created after scheduling are included and eligibility skips the rest. The console lists it first with its count taken from the cached storage totals (up to 15 minutes old). It can't be renamed, edited, deleted or have members added or removed (`BUILT_IN_GROUP`), and it isn't shown on account pages. Resolving or counting it is a full-table scan, fine at today's size.
- An account's groups are found by checking each group for its member row; there is no reverse index, as there are few groups.
- Recipients are always accounts. Emails go to the account's current address, read again at send time.

## Sending

States: `DRAFT → SCHEDULED → SENDING → SENT`, or `STOPPED` if stopped mid-send. **Cancel** takes a `SCHEDULED` campaign back to `DRAFT`. Only drafts can be edited or deleted.

- **Scheduling.** Scheduling checks the template has no problems and the audience has someone eligible, copies the template into the campaign, and writes the `CAMPAIGN_SEND` job with `dueAt = scheduledAt` (now for **Send now**, at most 90 days ahead). The one-minute maintenance schedule picks it up.
- **One run at a time.** Each job run first takes a lease on the campaign row (`leaseUntil`, the run's deadline plus a minute) in a conditional write. A run that finds the lease held just re-queues, so overlapping runs never send at once. A crashed run's lease expires.
- **First run (resolve).** Expand the groups and individual accounts into distinct account IDs and write a `RCPT` row for each: `PENDING`, or `SKIPPED` with a reason (no account, deleted, suspended, unverified, unsubscribed for `PRODUCT`, or suppressed). Rows already written are kept, so a resolve cut short by the deadline carries on next run.
- **Sending.**
  - Read `RCPT` rows 25 at a time from the saved `cursor`. Each `PENDING` row is checked for eligibility again, then sent, then marked `SENT` or `FAILED` with the error name.
  - Sends are paced to `CAMPAIGN_SEND_RATE` (default 10 a second; SES allows 14 by default and account notices share it).
  - A throttling error (or missing email config) pauses the run without failing anyone; the job comes back later.
  - The cursor and counts are saved after each page. A row is only sent while `PENDING`, so a crash repeats at most the one email being sent.
  - When the last page is done, counts are recounted from the rows, and the campaign becomes `SENT` with `finishedAt`.
- **Stop.** Stopping sets `STOPPED`; the next page the job reads marks every remaining `PENDING` row `SKIPPED (STOPPED)`. It takes effect within about 25 emails.
- **Not using `EMAIL` jobs.** Campaign emails don't go through per-recipient `EMAIL` jobs, so a large campaign can't hold up sign-in and security email.
- **Test sends** do use an `EMAIL` job, to the signed-in staff member's address, with `[Test]` before the subject. They have the Settings link in the footer but no one-click header. They arrive within a minute.
- **Write cost.** About 2 writes per recipient (the `RCPT` row and its status) plus one campaign update per 25.
- **Email content.**
  - **Rendering:** the `CAMPAIGN` member of the `Email` union renders the snapshot's Markdown into `renderEmail()`, with variables filled in per recipient.
  - **Markdown:** `#`/`##`/`###` headings, paragraphs, `-` and `1.` lists, `**bold**`, `*italic*`, `` `code` ``, `[links](https://…)`, `---`, and `[[Button]](https://…)`. Raw HTML is shown as text. Links must be `https://`, `http://` or `mailto:`.
  - **Variables:** `{{name}}`, `{{firstName}}`, `{{username}}`, `{{email}}`, `{{storageUsed}}`, `{{storageQuota}}`. They are filled in after rendering and escaped, so a display name can't add markup or links. An unknown variable stops the template from saving.
  - **Sender:** campaigns send from `CAMPAIGN_EMAIL_FROM` (`updates@<domain of EmailFrom>`), allowed in the jobs function's `ses:FromAddress` condition. Account notices keep `EMAIL_FROM`.
  - **Unsubscribe:** `PRODUCT` emails get a footer unsubscribe link and `List-Unsubscribe` plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers. `SERVICE` emails have neither.
- **Unsubscribe endpoints** (public):
  - The token in `t` is `<userId>.<HMAC-SHA256("unsubscribe:PRODUCT:<userId>")>`, signed with the `EmailLinkSecret` secret. It names the account rather than the address, so it keeps working after an email change.
  - `GET /v1/email/unsubscribe?t=` returns `{subscription: {email (masked), productUpdates}}` for the page.
  - `POST /v1/email/unsubscribe?t=` turns product updates off. It ignores the body, so mail apps' one-click form POST works. The browser proxy lets this one endpoint through without an Origin check and forwards no cookies.
  - `POST /v1/email/resubscribe?t=` turns them back on (same-origin only).
  - The `/unsubscribe` page needs a click to unsubscribe, so link scanners that open URLs can't unsubscribe anyone.
- **Bounces and complaints.** The `MailEventHandler` Lambda, on the `MailSuppressionRule` EventBridge rule, writes `EMAIL_SUPPRESSION` rows for hard bounces and complaints. The `Mail` configuration set also uses SES's own suppression list for both.

## Admin API

All routes live under `/api/v1/admin/email`. Contracts are in `packages/contracts/src/campaigns.ts`; client methods in `apps/admin/lib/api.ts`. The admin API is not in `npm run openapi`.

| Method & path | Permission |
| --- | --- |
| `GET /templates`, `GET /templates/:id` (with history) | `read` |
| `POST /templates`, `PUT /templates/:id` (`expectedUpdatedAt`), `DELETE /templates/:id` | `campaigns` |
| `POST /preview` `{subject, preheader, markdown, category, sampleUserId?}` → `{subject, html, text, problems}` | `read` |
| `POST /test` (same body; sends to the signed-in staff member; 10 a minute) | `campaigns` |
| `GET /groups`, `GET /groups/:id`, `GET /groups/:id/members?cursor=` | `read` |
| `POST /groups`, `PUT /groups/:id`, `DELETE /groups/:id` | `campaigns` |
| `POST /groups/:id/members` `{userIds?, identifiers?}` → `{group, added, alreadyMembers, unmatched}` | `campaigns` |
| `POST /groups/:id/members/remove` `{userIds}` | `campaigns` |
| `POST /audience/count` `{audience, category}` → `{total, eligible, skipped: {reason: n}}` | `read` |
| `GET /campaigns`, `GET /campaigns/:id`, `GET /campaigns/:id/recipients?status=&cursor=` | `read` |
| `POST /campaigns`, `PUT /campaigns/:id` (drafts), `DELETE /campaigns/:id` (drafts) | `campaigns` |
| `POST /campaigns/:id/schedule` `{at: ISO \| null, reason, expectedUpdatedAt}` | `campaigns` |
| `POST /campaigns/:id/cancel`, `POST /campaigns/:id/stop` `{reason}` | `campaigns` |

- **Permissions:** `campaigns` is ADMIN only. SUPPORT can view everything and preview.
- **Reasons:** scheduling, cancelling and stopping need a reason. Template and group edits don't, but are audited.
- **Guards:** a template used by a draft campaign can't be deleted; a group used by a campaign not yet resolved can't be deleted.
- **Audit:** every change writes an audit row, also filed under `ADMIN_AUDIT#TEMPLATE#<id>`, `#GROUP#<id>` or `#CAMPAIGN#<id>` for the item's own history.
- **Account page:** `GET /users/:id` includes `email: {productUpdates, suppressed, groups}`.

## Console UI

- **Navigation:** an **Email campaigns** entry in the sidebar, with tabs for `/campaigns`, `/email-templates` and `/email-groups`. Detail views use `?id=` (`?id=new` to create), as the console is a static export.
- **Campaigns list:** name, template, state badge, sent/total with skipped and failed, and time. It refreshes every 5 seconds while any campaign is scheduled or sending.
- **Campaign draft:** name, template picker, group checkboxes, single accounts by email, a live count ("12 people will get this email", with skipped reasons), the email preview, **Send me a test**, **Save draft**, **Delete draft**, and **Send or schedule…**, which asks for a reason and either sends now or at a local date and time.
- **Scheduled or sent campaign:** counts, a progress bar, when it was scheduled, started and finished, **Cancel schedule** or **Stop sending**, a recipient table filtered by status, the copied email, and history.
- **Template editor:** name, kind (product update or service notice), subject, preview line and Markdown on the left, with the variables listed. On the right is a preview rendered by the backend in a sandboxed frame: desktop or phone width, email or plain text, and "Preview as" an account. **Send me a test** and save.
- **Groups:** a list with member counts; a group page with paste-to-add (emails or usernames; unmatched ones are listed back), the member table with **Remove**, rename, delete and history.
- **Account page:** an **Email** card with product updates on or off, any bounce or complaint, and the account's groups with add and remove.

## Web

- Settings has an **Email** card with a **Product updates** checkbox. It saves through the existing `PATCH /v1/users/me` with `emailPreferences: {productUpdates}`.
- The unsubscribe confirmation page lives at `/unsubscribe`.

## Phases

1. **Foundations:**
   - `emailPreferences` and the suppression table;
   - the unsubscribe token, endpoint and page, and the Settings toggle;
   - `List-Unsubscribe` headers;
   - the bounce and complaint Lambda.
2. **Templates:** rows, the safe Markdown renderer, the `CAMPAIGN` email, the preview endpoint, and the console editor.
3. **Groups:** group and member rows, the member endpoints, the count endpoint, and the console editor.
4. **Campaigns:** rows, the `CAMPAIGN_SEND` job (resolve, then paced sends), test send, schedule, cancel and stop, and the console pages.
5. **Tests and rollout:**
   - **Backend tests** cover:
     - resolving recipients, removing duplicates and skipping addresses;
     - unsubscribe tokens;
     - resuming after a crash without sending twice;
     - pacing;
     - cancel and stop.
   - **Staging:** run a campaign on staging to `BETA_EMAIL` test addresses, then send to the staff group in production.

## Decisions (2026-10-07)

1. **Template format:** Markdown inside the branded layout. No raw HTML.
2. **Automations:** v1 is manual and scheduled one-off sends. Event-triggered sequences come later, as a separate phase.
3. **Recipients:** only accounts. People without an account (the waitlist, pasted addresses) never get promotional email.
4. **"Inactive since":** dropped. Groups have no rules at all.
5. **Approval:** one ADMIN with a reason is enough.
6. **Sender:** campaigns send from `updates@harbor0.com`. Phase 4 adds it as its own setting and allows it in the jobs function's `ses:FromAddress` IAM condition. Transactional mail keeps `EMAIL_FROM`.

## Status

All phases were built on 2026-10-07. They are uncommitted and not yet deployed.

- **Phase 1 (foundations):** product-update preference and Settings toggle, signed unsubscribe links, the three `/v1/email/*` endpoints, the `/unsubscribe` page, `List-Unsubscribe` headers, the bounce and complaint Lambda, and `EmailLinkSecret`.
- **Phases 2–4:** templates, groups and campaigns as described above, with the `CAMPAIGN_SEND` job and the `updates@` sender.
- **Phase 5:** backend tests in `apps/backend/test/email-preferences.test.ts` and `apps/backend/test/campaigns.test.ts` cover rendering and escaping, templates, groups, skip reasons, scheduling, cancel, throttling, stop, failures and overlapping job runs.

Rollout:
1. Deploy to staging. Check `updates@` is allowed by the SES domain identity and that the staging SES account is out of the sandbox (or the test addresses are verified).
2. Make a group of staff accounts on staging, send a product update and a service notice, and check: delivery, the footer link, Gmail's own unsubscribe button, and the `/unsubscribe` page.
3. Deploy to production and repeat with a staff group before any real campaign.
