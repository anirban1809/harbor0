# Deployment

## Cloudflare R2

The git-ignored `.env.cloud` file holds local deployment settings and credentials. After populating it, run `npm run cloud:validate-r2` to exercise the real S3 adapter in an isolated temporary bucket. That command removes only the bucket and objects it creates. Results are saved under the git-ignored `.cloud/` directory.

Create a dedicated private bucket. Leave both public `r2.dev` access and public custom domains disabled. Do not apply a lifecycle that deletes finalized objects independently of the database.

The optional script provisions a **new** bucket, browser CORS, and a two-day incomplete multipart cleanup rule:

```sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
R2_BUCKET=harbor-files WEB_ORIGIN=https://files.example.com npm run r2:provision
```

Supply values through a secure environment rather than committing a credentials file. The administrative Cloudflare API token used for provisioning is different from the S3 credentials the runtime uses.

Create S3 credentials scoped to object read/write in this bucket. Store this JSON in AWS Secrets Manager in the Lambda region:

```json
{ "accessKeyId": "<R2 access key>", "secretAccessKey": "<R2 secret>" }
```

No R2 credentials go into the web app, Electron bundle, browser storage, or generated API client. The Lambda reads the secret at cold start. After rotation, recycle Lambda environments or redeploy to refresh cached credentials.

The endpoint is `https://<account-id>.r2.cloudflarestorage.com`, region `auto`. Jurisdiction-specific buckets require their corresponding endpoint and provisioning header.

The provisioning script derives the jurisdiction header from `R2_ENDPOINT`, including the supplied `.us.r2.cloudflarestorage.com` endpoint. HTTPS web origins are required except for `localhost`/`127.0.0.1` during live development validation. To load the local deployment file explicitly, run `npx tsx --env-file=.env.cloud scripts/provision-r2.ts`.

R2 references: [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [CORS policy API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/cors/methods/update/), [multipart lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/).

## AWS

Use a deployment role with CDK/CloudFormation permissions and bootstrap the chosen account/region. Cognito uses `COGNITO_DEFAULT`, sending signup and password-reset messages from AWS's `no-reply@verificationemail.com`. This sender is not available for custom application emails through the SES API. File-invitation emails require a separately verified SES identity and production access as appropriate. [AWS email configuration](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html).

Once the dedicated R2 bucket exists and `.env.cloud` includes `AWS_REGION` and `WEB_ORIGIN`, `npm run cloud:deploy` verifies bucket access, stores the R2 runtime credentials in Secrets Manager, builds the Lambda package, and deploys the stack. Leave `EMAIL_FROM` empty to keep custom invitation emails unconfigured, as in the current deployment. Those jobs are retained for retry; transfers remain claimable after verified signup. No Luminote sender is used. The script writes non-secret resource outputs to `.cloud/outputs.json`. It reuses only a secret tagged for this project, and never places raw R2 credentials in CloudFormation parameters.

```sh
npm ci
npm run build:backend
npm run infra:synth
npx cdk bootstrap --app 'npx tsx infra/app.ts'
npx cdk deploy --app 'npx tsx infra/app.ts' \
  --parameters WebOrigin=https://files.example.com \
  --parameters R2Endpoint=https://ACCOUNT.r2.cloudflarestorage.com \
  --parameters R2Bucket=harbor-files \
  --parameters R2SecretArn=arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME
```

The stack provisions:

- DynamoDB on-demand table, job index, TTL for transient records, point-in-time recovery, retained deletion policy.
- Cognito user pool, email verification, password policy, public app client with 15-minute access tokens, 30-day rotating refresh credentials and token revocation. `preferred_username` is required. A pre-signup Lambda reserves normalized usernames atomically.
- API Gateway HTTP API, Lambda API and scheduled maintenance worker, a failure queue, logging and error alarms.
- A Cognito hosted-login domain and desktop `harbor://auth/callback` redirect.

Outputs provide API URL, user pool/client IDs, hosted login URL, and table name. Attach notification actions to the CloudWatch alarms for your operations team. Application job failures are structured logs and retained/retried in DynamoDB; alarm on the `job_failed` event as well as Lambda invocation errors.

Verify signup, email verification, password reset, refresh rotation, revocation, R2 PUT/HEAD/complete/GET/ranges, SES invitations, and scheduled expiry in the actual account before opening signups. CDK synthesis does not test those provider interactions.

`npm run cloud:validate` exercises the deployed API and maintenance Lambda with isolated Cognito fixtures. It suppresses fixture emails, explicitly verifies test identities through the admin API, tests the verification gate, and removes the identities afterward. This does not prove inbox delivery. `npm run cloud:validate-web` tests the configured web origin in Chromium against the same live stack. These scripts create and delete their own test files; unreferenced objects are reclaimed after the application's normal one-hour grace period.

## Web

The web application uses a private S3 bucket behind CloudFront. The `HarborWeb` stack provisions the bucket, origin access control, HTTPS distribution, security headers, static caching policy and an uncached `/api/*` behavior pointing to the existing API Gateway. The same Lambda handles the browser cookie gateway and the native bearer-token API. S3 never stores user file contents.

After the backend has been deployed and `.env.cloud` is populated:

```sh
npm run cloud:deploy-web
npm run cloud:validate-hosting
npm run cloud:validate-web
```

Deployment builds the static export in `.cloud/web-export/out`, creates/updates the CloudFront stack, writes its outputs to `.cloud/web-outputs.json`, updates `WEB_ORIGIN` to the distribution's HTTPS address, adds that address to R2 CORS while preserving existing allowed origins, and redeploys the backend/Cognito configuration. It uploads versioned assets before HTML and waits for a CloudFront invalidation. The asset bucket blocks all public access and has versioning; the CloudFront service is its only public delivery path. The existing localhost Next.js server can continue to use the bearer-token API through its local session proxy.

To build the static files without deploying, run `npm run build:web-static`. The script uses a separate staging directory so local development routes remain available. Normal deployments retain older hashed chunks for existing browser sessions.

For local development, or an alternative Node-compatible host, configure these server-only variables:

```text
API_URL=https://<api-id>.execute-api.<region>.amazonaws.com
APP_ORIGIN=https://files.example.com
```

Build with `npm run build -w @harbor/web`; run with `npm run start -w @harbor/web`. Require HTTPS. Keep `APP_ORIGIN`, API CORS, and R2 CORS identical. Refresh/access cookies are HTTP-only, Secure in production, SameSite Strict, and never exposed to client JavaScript. State-changing proxy requests require the exact configured Origin.

## Desktop

Set public deployment configuration when launching/building the app:

```text
HARBOR_API_URL=https://<api-id>.execute-api.<region>.amazonaws.com
```

Do not set `HARBOR_DEV_AUTH` for a release. Packaged applications reject the development authentication path. Users sign in with their account email and password inside the app. No browser or desktop Cognito configuration is required. Packaged configuration loads the public API URL from `dist/desktop-config.json`; explicit launch-environment values take precedence. Development launches also read `apps/desktop/.env` and `apps/desktop/.env.local`, with shell values taking precedence.

```sh
npm run build -w @harbor/desktop
npm run package -w @harbor/desktop
```

The builder configuration supports macOS DMG, Windows NSIS, and Linux AppImage/deb. Build on each target OS and validate x64/arm64 as needed. Supply macOS Developer ID signing/notarization credentials and a Windows signing identity through the build environment. Automatic updating is not connected yet; distribute signed installers manually until an authenticated release/update feed is implemented.

The application persists an encrypted refresh credential in its user-data directory through Electron `safeStorage`. Linux requires a functioning secret service/keyring. SQLite is a durable cache/journal, not the cloud authority. Back up the database before repair; preserve local unsynced files and use a new dedicated sync folder when rebuilding an account cache.

## Shared-sync desktop release (0.1.1)

The repeatable release flow uses the deployed resource outputs and the exact installed Electron version:

```sh
npx tsx scripts/package-desktop-release.ts --mac dmg --arm64
npx tsx scripts/desktop-release-check.ts
npx tsx --env-file=.env.cloud scripts/validate-shared-sync-live.ts
npx tsx --env-file=.env.cloud scripts/publish-desktop-release.ts
```

The publisher requires successful live and packaged-app evidence, rejects replacement of an existing version with different bytes, uploads the installer and checksum manifest to the existing private web asset bucket under `downloads/`, and verifies delivery through CloudFront. Regular web deployments preserve this prefix. No backend secrets or development authentication settings are included in the bundle.

On this machine no Developer ID certificate is available. Version 0.1.1 was built with `CSC_IDENTITY_AUTO_DISCOVERY=false`; it is unsigned and not notarized. Installing it requires the user’s macOS approval. A signed release requires supplying a valid signing identity through the build environment. There is no automatic desktop update feed.
