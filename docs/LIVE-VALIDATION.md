# Live deployment and validation

The web app is now public at [harbor0 on CloudFront](https://d1bpha1d51nhxy.cloudfront.net). The historical backend checks below remain valid; current hosting resources and the expanded browser verification are recorded in [web deployment](WEB-DEPLOYMENT.md).

Verified on 2026-09-25T09:46:31.022Z. Stack `HarborStorage` reached `CREATE_COMPLETE` in AWS `us-east-1`.

## Active resources

| Resource                  | Identifier                                             |
| ------------------------- | ------------------------------------------------------ |
| API                       | https://zlh5nzxdy6.execute-api.us-east-1.amazonaws.com |
| API Lambda                | HarborStorage-ApiF70053CD-QqxMuTJ4y2au                 |
| Maintenance Lambda        | HarborStorage-Maintenance3AE505C2-Vc6QNSjQ4KmD         |
| Signup trigger Lambda     | HarborStorage-Registration8466E9D0-2HpwRubr25us        |
| DynamoDB table            | HarborStorage-MetadataBDB8F4DB-M24Q0HDBEMKB            |
| Cognito pool              | us-east-1_4CxUM88qs                                    |
| Cognito public app client | 3d6e331fll3p8mkv3k8vafk19r                             |
| R2 bucket                 | harbor-files, US jurisdiction                          |
| Web origin                | http://localhost:3000                                  |

The DynamoDB table is ACTIVE with on-demand billing. Lambda reads R2 runtime credentials from AWS Secrets Manager. The R2 managed public URL is disabled and no custom domains are attached. CORS permits the configured localhost origin; incomplete multipart uploads expire after two days.

## Verification results

- **24 live backend checks passed**, covering Cognito authentication and verification gating, token rotation, DynamoDB idempotency/quota/sync, Lambda-to-R2 uploads and downloads, private access, transfers, save, expiry, deletion, and access/refresh/device revocation.
- **5 live browser checks passed**: localhost login through the BFF, protected cookies, direct R2 upload, checksum-matched download, and logout.
- **10 direct R2 checks passed**, including a real two-part upload, resume receipts, completion replay, ranged download, unsigned access rejection, abort, and object deletion. The temporary validation bucket was removed.
- Lint, TypeScript, 27 unit/contract tests and production backend/web/desktop builds passed after the deployment changes.

Evidence is saved locally in [backend results](../.cloud/live-validation.json), [browser results](../.cloud/live-web-validation.json), and [R2 results](../.cloud/r2-validation.json). Those files and all deployment credentials are excluded from Git.

The cloud fixtures use dedicated synthetic identities, suppress email delivery, and explicitly set verification status through Cognito admin APIs. The pre-signup trigger was exercised through admin account creation. Test Cognito identities were removed. Test files were logically deleted and quota returned to zero; unreferenced R2 objects are reclaimed by the maintenance worker after the normal one-hour grace period. Audit/test metadata remains in DynamoDB.

## Email configuration and remaining checks

Cognito is configured with `COGNITO_DEFAULT`: signup and password-reset messages use AWS's `no-reply@verificationemail.com`. No Luminote sender is configured. [AWS documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html).

Actual inbox receipt, user-entered signup verification codes, and password-reset completion have not been tested; a recipient inbox is still needed. The default Cognito sender cannot send arbitrary application invitations through SES. `EMAIL_FROM` is intentionally empty, so invitation email jobs remain pending/retryable; recipients can still register, verify their email, and claim pending transfers. Configure a separate verified SES sender to enable those emails.

Desktop managed-login PKCE, signed installers, alarm delivery, and disaster-recovery drills remain outside this verification.

## Using this deployment

Open http://localhost:3000 and create a real account. Development Alice/Bob credentials only work when the web app points back to the local emulator API. The deployed API does not accept development tokens.

To repeat the live checks with the local credential file:

```sh
npm run cloud:validate-r2
npm run cloud:validate
npm run cloud:validate-web
```

## Shared folder sync — 28 September 2026

The updated `HarborStorage` stack deployed successfully. Twelve feature-specific live checks passed using two isolated Cognito accounts, real local folders, filesystem watchers and SQLite journals against the deployed Lambda API, DynamoDB and R2. They covered invitation delivery, denial before acceptance, both directions of edits, nested folder creation, rename, confirmations from both accounts, owner storage accounting, recipient deletion, revocation and local-file preservation. Fixture users and files were cleaned up. Evidence is in `.cloud/shared-sync-validation.json`.

Desktop 0.1.1 was packaged for macOS Apple Silicon and launched with an isolated profile, bundled production settings and sandboxed renderer. The installer is unsigned because no Developer ID certificate is available. Evidence is in `.cloud/desktop-release-validation.json`; the public download and SHA-256 are recorded in `.cloud/desktop-release.json` after publication.

Installer published and verified: [harbor0 0.1.1 — macOS Apple Silicon](https://d1bpha1d51nhxy.cloudfront.net/downloads/harbor0-0.1.1-mac-arm64.dmg). SHA-256: `14cf11492cdf91c335d3051465691b2cecae27711cb6a19356a702dc77e4b755`.
