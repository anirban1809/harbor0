# Two-way shared folder sync

Backend deployed on 28 September 2026. Desktop 0.1.1 is required for sharing controls and recipient synchronization. The Apple Silicon macOS installer is unsigned; automatic updates, Developer ID signing and notarization are not configured. No database migration or new infrastructure was required.

[Download desktop 0.1.1 for macOS Apple Silicon](https://d1bpha1d51nhxy.cloudfront.net/downloads/harbor0-0.1.1-mac-arm64.dmg). This is a manual update; install the updated desktop client on devices using shared sync.

## Use

1. On the owner’s desktop, add a folder to Sync. Open its menu and choose **Share folder**.
2. Enter another registered account’s email or username and send the invitation.
3. On the recipient’s desktop, find the invitation in **Sync → Shared with you**. Choose **Accept invitation**, select a local folder, and choose **Accept and start syncing**.
4. Both accounts can create, edit, rename, move, and delete contents. An existing local folder’s contents are uploaded too; an empty local folder starts with only the owner’s files.
5. The owner can remove access in the sharing dialog. The recipient’s devices detach when they next connect; downloaded files and queued local edits remain on disk. A recipient can also stop sync on one computer and link it again later without affecting other devices.

Only the owner can share or revoke access. The shared root itself cannot be renamed, moved or deleted by the recipient; its contents are editable. Offline conflicts preserve divergent files for review. Local renames continue to use the existing create/delete watcher behavior.

## Storage and security

- One folder tree lives under the owner’s account. Recipient upload sessions belong to the recipient, while reservations, versions, and completed bytes count against the owner’s quota. Cancellation/expiry releases the same owner reservation.
- Pending or declined invitations grant no folder access. New upload part URLs and final publication recheck current editor access. Previously issued storage URLs retain their existing short expiry.
- Recipient synchronization reads a revision for the accepted folder and reconciles only that subtree when it changes. It does not expose the owner’s account-wide event feed. Moving contents out of the shared subtree also changes its revision.
- Delivery receipts include the account and installation, so identical device IDs in two accounts cannot confirm each other’s copies. Membership guards cover owner and recipient changes. Reinvitations receive a new identity and require fresh confirmations.
- Synced files are always kept in the owner's cloud storage, and every linked device downloads changes from there. Delivery receipts only report sync progress. Files released from the cloud before this change are asked back from the devices that hold them (`scripts/rehydrate-sync.ts`); until a device uploads one again, opening it waits for that device.
- Up to 20 active sync invitations per owner are supported in this version. Invitations are displayed in the app; this feature sends no external email. Invitations require an existing registered account.
- Large shared folders currently use a full metadata reconciliation after a folder revision changes. A paginated per-folder delta feed is a future scalability improvement.

## API

- `POST /v1/sync/shares`: invite by exact email or username; operation ID makes retries idempotent.
- `GET /v1/sync/shares`: sent and received active invitations, root names and account display names.
- `POST /v1/sync/shares/:id/respond`: accept or decline as the recipient.
- `GET /v1/sync/shares/:id/status`: accepted recipient’s folder metadata and revision.
- `DELETE /v1/shares/:id`: existing owner-only revocation endpoint.

The existing create-folder, upload, metadata, folder-list, mutation and sync-receipt APIs enforce shared access. Existing ordinary shares preserve their behavior; switching an ordinary Drive grant to sync requires removing that grant first.

## Validation

- Backend tests: invitation consent, account isolation, owner storage accounting, simultaneous revision conflicts, receipt isolation, release/rehydration, outstanding-upload revocation, cancellation refunds, and reinvitations.
- Desktop integration test: two real local folders and SQLite journals, real application API and sync engines with in-memory storage; two-way updates, nested files, renames, conflict preservation, deletions and revocation. Watcher jobs are triggered deterministically.
- `npx tsx scripts/shared-sync-ui-check.ts`: actual Sync components with a fixture bridge; owner invitation/removal, recipient folder selection/acceptance, and owner-only sharing controls. Screenshots are saved in `test-results/shared-sync/`.
- `npm run check`, `npm run build:backend`, and `npm run build -w @harbor/desktop`.

Live validation passed 12 checks using two separate Cognito accounts, two real local folders and SQLite journals, actual filesystem watchers, API Gateway/Lambda, DynamoDB and private R2. It covered invitations, pre-acceptance denial, both directions of editing, nested creation, rename, delivery confirmations, owner quota, deletion, revocation and preservation of queued local edits. Fixture accounts and files were cleaned up. Evidence: `.cloud/shared-sync-validation.json`. This used two engines on one Mac; two physical computers and Windows/Linux releases remain untested.
