# Staging

Staging is a full, separate copy of harbor0's infrastructure in the same AWS account. It has no shared resources with production. Every deploy script and CDK app reads `HARBOR_ENV` (see `infra/environment.ts`). When it is unset they target production, which keeps its stack names and templates.

|                   | Production                                  | Staging                                                          |
| ----------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| Stacks            | `HarborStorage`, `HarborWeb`, `HarborAdmin` | `HarborStorageStaging`, `HarborWebStaging`, `HarborAdminStaging` |
| Settings          | `.env.cloud`                                | `.env.staging` (template: `.env.staging.example`)                |
| Deploy outputs    | `.cloud/*.json`                             | `.cloud/staging/*.json`                                          |
| R2 bucket         | `harbor-files`                              | its own bucket, e.g. `harbor-files-staging`                      |
| R2 runtime secret | `harbor-storage/r2`                         | `harbor-storage-staging/r2`                                      |
| APNs secret       | `harbor0-apns`                              | `harbor0-staging-apns`                                           |
| Cognito login     | `harbor-<acct>-<region>`                    | `harbor-staging-<acct>-<region>`                                 |
| Web domain        | `app.harbor0.com`                           | `WEB_DOMAIN` (default `staging.harbor0.com`)                     |
| Source            | manual deploys                              | the `staging` branch only                                        |

Staging data is disposable. The table and both user pools are deleted with the stack, point-in-time recovery is off, and pages send `X-Robots-Tag: noindex`. `deploy-cloud` refuses to use the bucket that production records in `.cloud/deployment.json`.

## Deploying

Pushing to `staging` runs `.github/workflows/deploy-staging.yml`. It runs lint, typecheck and tests, then `staging:deploy` (backend), `staging:deploy-web`, and `staging:deploy-admin` when `STAGING_ADMIN_ORIGIN` is set. Promote changes by merging into `staging`:

```sh
git checkout staging && git merge main && git push
```

Local deploys use the same scripts. They refuse to run unless the checkout is on `staging`. Set `HARBOR_ALLOW_ANY_BRANCH=true` to override this deliberately.

```sh
npm run staging:deploy        # backend stack
npm run staging:deploy-web    # web stack + assets (then redeploys the backend with the web origin)
npm run staging:deploy-admin  # optional console
npm run staging:admin-staff -- add you@example.com admin
npm run staging:validate      # live end-to-end checks against staging
```

Desktop and mobile clients target staging through their API URL setting, for example `HARBOR_API_URL=<HarborStorageStaging ApiUrl> npm run dev:desktop`.

## One-time setup

1. `cp .env.staging.example .env.staging` and fill it in. Run `npm run staging:r2:provision` to create the staging bucket. Then create S3 keys in Cloudflare scoped to that bucket only.
2. From the `staging` branch, run `npm run staging:deploy` and then `npm run staging:deploy-web`.
3. Optional custom domain: request an ACM certificate in us-east-1 for `staging.harbor0.com` and validate it in DNS. Set `WEB_CERT_ARN`, rerun `staging:deploy-web`, and add a CNAME from `staging` to the distribution hostname.
4. CI role: run `npx cdk deploy HarborGitHubStaging --app 'npx tsx infra/github.ts'`. The role it creates can only be assumed by workflow runs on `refs/heads/staging` of this repository.
5. In GitHub, go to **Settings → Secrets and variables → Actions** and add the following.
   - Variables:
     - `STAGING_AWS_ROLE_ARN`: the `StagingDeployRoleArn` output
     - `STAGING_R2_BUCKET`
     - `STAGING_R2_ENDPOINT`
     - `STAGING_WEB_ORIGIN`: the deployed staging URL
     - Optional: `STAGING_WEB_DOMAIN`, `STAGING_WEB_CERT_ARN`, `STAGING_EMAIL_FROM`, `STAGING_AWS_REGION`, `STAGING_ADMIN_ORIGIN`, `STAGING_ADMIN_DOMAIN`, `STAGING_ADMIN_CERT_ARN`
   - Secrets:
     - `STAGING_R2_ACCESS_KEY_ID`
     - `STAGING_R2_SECRET_ACCESS_KEY`
     - `STAGING_CLOUDFLARE_API_TOKEN`: used to update the staging bucket's CORS rule

## Tearing down

```sh
HARBOR_ENV=staging npx cdk destroy HarborAdminStaging --app 'npx tsx infra/admin.ts'
HARBOR_ENV=staging npx cdk destroy HarborWebStaging --app 'npx tsx infra/web.ts'
HARBOR_ENV=staging npx cdk destroy HarborStorageStaging --app 'npx tsx infra/app.ts'
```

The web and admin asset buckets are retained, so empty and delete them by hand. Delete the R2 bucket and the `harbor-storage-staging/r2` secret separately.
