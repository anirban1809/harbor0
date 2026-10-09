# Management console

An internal console for staff to find accounts, help people and change account settings. It is
separate from the product at every layer:

| Layer   | Product                              | Console                                               |
| ------- | ------------------------------------ | ----------------------------------------------------- |
| Web app | `apps/web` on app.harbor0.com        | `apps/admin` (static export) on its own distribution  |
| API     | `Api` Lambda, `HttpApi`              | `Admin` Lambda (`index.admin`), `AdminHttpApi`        |
| Sign-in | `Users` Cognito pool                 | `Staff` pool: no self sign-up, password sign-in       |
| Session | `harbor_access` cookies via `/api/*` | `harbor_staff_*` HTTP-only cookies, `SameSite=Strict` |
| Storage | R2 credentials                       | none — no console action reads file bytes             |

Code: `apps/backend/src/admin/` (`api.ts` routes and cookie session, `service.ts` actions and
audit log, `directory.ts` customer pool admin calls, `staff-auth.ts` staff sign-in),
`packages/contracts/src/admin.ts` (schemas and role permissions), `apps/admin` (UI),
`infra/admin.ts` (HarborAdmin stack), staff pool and Lambda in `infra/app.ts`.

## Roles

Staff belong to the Cognito group `admin` or `support`; anyone in neither is refused.

| Action                                           | Support | Admin |
| ------------------------------------------------ | :-----: | :---: |
| Search accounts, view storage, devices, activity |    ✓    |   ✓   |
| Add internal notes                               |    ✓    |   ✓   |
| Reset password (emails a code)                   |    ✓    |   ✓   |
| Resend verification email                        |    ✓    |   ✓   |
| Sign out everywhere / sign out one device        |    ✓    |   ✓   |
| Mark an email verified                           |         |   ✓   |
| Change the storage limit                         |         |   ✓   |
| Suspend / restore                                |         |   ✓   |
| Delete account (type the email to confirm)       |         |   ✓   |

Every change requires a reason and writes an append-only audit entry (`ADMIN_AUDIT` globally and
`ADMIN_AUDIT#<userId>` per account, newest first) naming the staff member. Quota changes write
the entry in the same transaction as the change.

## What each action does

- **Storage limit** sets `storageQuotaBytes` on the PROFILE and records `PROFILE_UPDATED`, so open
  apps refresh. A limit below current use deletes nothing; uploads fail until space is freed.
- **Reset password** calls `AdminResetUserPassword`: the old password stops working and the person
  uses “Forgot password” with the emailed code. The app API maps the resulting
  `PasswordResetRequiredException` to `PASSWORD_RESET_REQUIRED`. Staff never see or set passwords.
- **Sign out everywhere** revokes refresh tokens (`AdminUserGlobalSignOut`) and ends every
  `DEVICE#` session; sync folders and backups pause, nothing is deleted.
- **Suspend** sets `suspendedAt` on the PROFILE (`ensureUser` refuses with `ACCOUNT_SUSPENDED` on
  every request, so it is immediate even for cached tokens), disables the Cognito user and signs
  all devices out. Files are kept and still count. **Restore** reverses it.
- **Delete** runs the same flow as a user’s own deletion (`deleteAccount`: tombstone, claims
  released, purge after 30 days) and removes the Cognito user.
- Unverified sign-ups have no PROFILE yet; the console shows them from the directory only.

## Local development

`npm run dev` (with `DEV_AUTH=true`) also starts the console API on `127.0.0.1:8789`; then
`npm run dev:admin` serves the console at http://localhost:3300 (it proxies `/api/*` to 8789).
Staff: `admin@example.test` (admin) and `support@example.test` (support), password
`Development-only-123!`. Tests: `apps/backend/test/admin.test.ts`.

## Deploying

1. `npm run cloud:deploy` — creates the staff pool, `Admin` Lambda and `AdminHttpApi`.
2. `npm run cloud:deploy-admin` — deploys HarborAdmin, writes `ADMIN_ORIGIN` to `.env.cloud`,
   redeploys HarborStorage so the console API accepts that origin (until then it refuses every
   change), then uploads the export. `:assets` re-uploads only.
   Optional `.env.cloud` settings: `ADMIN_DOMAIN` + `ADMIN_CERT_ARN` (us-east-1 ACM) for a custom
   hostname, `ADMIN_ALLOWED_IPS` (comma-separated) to restrict the console to office/VPN IPs.
3. Invite staff: `npm run admin:staff -- add someone@harbor0.com admin|support`. Cognito emails
   a temporary password; the first sign-in sets a password (14+ characters). Also `list`,
   `role`, `disable`, `enable`, `reset-password`.

Staff sessions: 15-minute access tokens, 12-hour refresh, refresh rotation and revocation on.
