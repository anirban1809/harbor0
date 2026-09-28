# S3 and CloudFront web deployment

[Open harbor0](https://d1bpha1d51nhxy.cloudfront.net)

Latest backend and web deployment verified on 2026-09-28T07:24:15.714Z.

| Resource                | Value                                    |
| ----------------------- | ---------------------------------------- |
| Stack                   | HarborWeb                                |
| Web URL                 | https://d1bpha1d51nhxy.cloudfront.net    |
| CloudFront distribution | EWWU9NVI82VU1                            |
| S3 asset bucket         | harborweb-webassets27872646-9eas77mscxwh |
| Backend stack           | HarborStorage, us-east-1                 |

## Request handling

CloudFront serves the static Next.js export from a private S3 bucket through origin access control. Direct anonymous S3 reads are denied. HTTP redirects to HTTPS. Hashed assets use immutable caching; HTML is revalidated.

The routing update adds a viewer-request function to resolve clean page URLs such as `/settings` to their exported `.html` files. Next.js assets and navigation payloads retain their original paths, and the separate API behavior is unchanged. The routing function is deployed, including direct access to `/backups`. Full infrastructure updates use `npm run cloud:deploy-web`; subsequent UI-only releases can use the assets-only command below.

Requests to `/api/*` go to API Gateway and the existing API Lambda. The browser gateway keeps Cognito tokens in Secure, HTTP-only, SameSite Strict cookies, verifies Origin on writes, rotates refresh credentials internally, and strips tokens from JSON. CloudFront disables caching for API responses, forwards cookies and Origin, and preserves authentication error statuses.

User files stay in private Cloudflare R2. Its CORS policy includes the CloudFront URL and preserves localhost. Cognito's logout URL and the backend's primary web origin now use the CloudFront address. Existing accounts and stored files are unchanged. Cognito still uses its AWS default sender; custom invitation email remains unconfigured.

## Folder backups deployment

The backend and web app include Archives, Backups, and Restore/Export. The updated desktop client is required for folder watching, automatic and on-demand backup work, and local restore execution.

Seven live checks verified the one-hour deferral, automatic uploads to private R2, on-demand versions, per-run file records, the three web tabs, export of historical bytes, and web-requested restore to the original local file. All nine hosting checks also passed. The synthetic test account was removed and its test folder was submitted for permanent deletion through the normal cleanup workflow.

Run `npx tsx --env-file=.env.cloud scripts/validate-live-backups.ts` to repeat this isolated live check. Evidence: [backup validation](../.cloud/live-backups-validation.json), [backup screenshot](../.cloud/live-backups.png), and [hosting validation](../.cloud/web-hosting-validation.json).

## Validation

**9 live hosting checks passed:**

- CloudFront distribution is deployed and enabled
- API caching is disabled at every CloudFront TTL
- CloudFront forwards session cookies and Origin without replacing the API hostname
- S3 is private and CloudFront uses origin access control
- Direct anonymous S3 access is denied
- HTTP redirects to HTTPS
- Public HTML loads with HTTPS security headers
- Versioned JavaScript assets are served with immutable caching
- Unauthenticated API requests retain their JSON status and are not cached

**10 live browser checks passed:**

- Web session gateway authenticates against live Cognito
- Login JSON does not expose credentials
- Access and refresh cookies are HTTP-only and SameSite Strict
- HTTPS sessions use Secure cookies
- Authenticated responses are not cached or shared with anonymous visitors
- Cross-origin authenticated writes are blocked
- Expired access cookies renew through rotating Cognito refresh credentials
- Browser hash worker and direct R2 upload succeed
- Browser download matches original SHA-256
- Browser logout clears the authenticated session

Lint, TypeScript, 32 unit/contract tests and both static and normal web builds passed. All 28 generated static files were checked for the configured cloud credentials; none were included. Synthetic Cognito identities and test files were removed, with physical object cleanup following the normal retention grace period.

Evidence: [hosting checks](../.cloud/web-hosting-validation.json), [browser checks](../.cloud/live-web-validation.json), and [browser screenshot](../.cloud/live-web.png). Evidence and deployment credentials are excluded from Git. Actual signup/password-reset inbox delivery remains pending a recipient inbox, as documented in the backend validation report.

## Redeploy

```sh
npm run cloud:deploy-web
npm run cloud:validate-hosting
npm run cloud:validate-web
```

The deploy script reads the existing backend outputs and local credentials, builds the export, updates both stacks and R2 CORS, uploads assets before HTML, and waits for a CloudFront invalidation. Local development remains available with the Next.js server.

## Publishing UI-only changes

Run `npm run cloud:deploy-web:assets` to publish to the existing bucket and distribution without updating infrastructure, backend configuration, Cognito, or R2 CORS. This builds and checks the isolated export, uploads hashed assets before HTML, retains older hashed chunks, and waits for CloudFront invalidation.

The export copies `apps/web/postcss.config.mjs` into its staging directory so Tailwind generates the same shadcn utilities as local development. The build fails if Tailwind directives remain unprocessed or essential utilities are missing. Both deployment paths run `npm run test:web-styles` before uploading. That browser check serves the actual static export and verifies button colors, the compact Drive table, sidebar storage, file-grid borders/padding, the absence of dashboard cards, the visually hidden table caption, inline folder-entry and rename-dialog focus, dark mode, responsive layouts, and direct access and refresh on every workspace route using isolated API fixtures.

To run the same read-only asset checks against a published release, use:

```sh
WEB_STYLES_URL=https://d1bpha1d51nhxy.cloudfront.net npm run test:web-styles
```

This uses a separate browser session and fixture responses; it does not log in or modify account data. Screenshots are saved under `test-results/web-styles/`.
