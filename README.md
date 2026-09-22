# Arz Neshan production infrastructure

This repository is the production source of truth watched by Coolify. Application
repositories publish immutable images to the private registry and dispatch a
validated promotion event here. This repository records the selected image tags;
Coolify never builds application source.

The production resource is one Git-based Docker Compose application. It runs the
API and two images produced by `arz-neshan-frontends`: `web` contains the public
and tenant-workspace Angular applications, while `platform` contains the private
operator console. Keeping them in one Compose project preserves private API
service discovery (`api:3000`) and makes the selected release auditable in one
commit.

## Release flow

```text
app pull request -> lint, tests, production build, container build
main push        -> publish sha-<commit> image
                 -> repository_dispatch(image_published)
                 -> update compose.coolify.yml
                 -> commit main, or open an API migration PR
                 -> Coolify observes the infra commit and deploys it
```

The API and frontend workspace release independently. A frontend release updates
its two images atomically:

```text
regi.mohsenamani.com/arz-neshan-infra/api:sha-<commit>
regi.mohsenamani.com/arz-neshan-infra/web:sha-<commit>
regi.mohsenamani.com/arz-neshan-infra/platform:sha-<commit>
```

`release-state.json` records the source repository, source SHA, workflow run
number, and tag for each deployed service. The workflow rejects stale run numbers
and maps service names to fixed registry paths instead of trusting image names
from dispatch payloads.

`scripts/validate-deployment.mjs` verifies the fully rendered Compose model,
release metadata/image consistency, production safety flags, the absence of host
port mappings and source builds, and that all API migration jobs use the exact
API image selected for deployment.

## GitHub setup

Add these Actions secrets to the API and frontend repositories. Organization
secrets restricted to those repositories may be used instead of duplicating them.

| Secret                 | Value                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `REGISTRY_USERNAME`    | Username allowed to push to the API, web, and platform registry repositories                  |
| `REGISTRY_PASSWORD`    | Registry password or token                                                                   |
| `INFRA_DISPATCH_TOKEN` | Fine-grained GitHub token restricted to `mohsen-amani/arz-neshan-infra` with Contents: write |

Add the public `TURNSTILE_SITE_KEY` Actions variable to the frontend repository.
The web Docker build deliberately fails when it is missing. Keep the matching
`TURNSTILE_SECRET_KEY` only in Coolify's secret environment, and authorize the
`ADMIN_BASE_DOMAIN` hostname on that Turnstile widget; Cloudflare applies that
authorization to its subdomains too.

The infra workflow uses its repository-scoped `GITHUB_TOKEN`. In the infra
repository settings:

1. Give Actions read/write workflow permissions.
2. Allow GitHub Actions to create and approve pull requests.
3. Configure the `main` ruleset so the release workflow may push validated
   non-migration image updates. Keep human review required for migration PRs.

The repositories and their allowed service identities are:

| Service identity | Source repository                    | Published images |
| ---------------- | ------------------------------------ | ---------------- |
| `api`            | `mohsen-amani/arz-neshan-api`        | `api`            |
| `frontends`      | `mohsen-amani/arz-neshan-frontends`  | `web`, `platform` |

## Registry and Coolify setup

The registry must present a publicly trusted HTTPS certificate to GitHub-hosted
runners and the Coolify server. Authenticate Docker on the deployment server as
the same operating-system user configured for that Coolify server:

```sh
printf '%s' "$REGISTRY_PASSWORD" | docker login regi.mohsenamani.com \
  --username "$REGISTRY_USERNAME" --password-stdin
```

Test an exact pull after the first application workflow publishes an image. Never
put registry credentials in this repository or in application runtime variables.

In Coolify:

1. Create a private GitHub application from `mohsen-amani/arz-neshan-infra`,
   branch `main`, using the Docker Compose build pack and `/compose.coolify.yml`.
2. Enable automatic deployment for infra-repository pushes.
3. Copy `.env.example` into Coolify's environment editor and replace every
   placeholder. Mark database, JWT, Turnstile, SMS, internal-jobs, HesabPay,
   platform-owner, SMTP, S3, and Vault credentials as secrets.
4. Attach the apex, `www`, `admin`, wildcard tenant, and exact API hostnames to
   `web:8080`. Attach only the private operator hostname to `platform:8080`.
   Add apex and proxied wildcard DNS records plus first-level wildcard TLS
   coverage. Ensure exact `api` and `platform` routes win over the wildcard.
5. Do not assign a domain or public port to `clamav`, `reminders`, `migration`,
   or `financial-migration`.
6. Preserve `attachments_data` when local attachment storage is selected.

Do not select the Dockerfile build pack and do not paste the Compose definition
into a source-less Coolify Service. The Git repository is the canonical Compose
definition and its commits are the deployment history.

The three `PLATFORM_OWNER_*` values seed the first platform account only when
the platform-user table is empty. After the first account exists, remove those
bootstrap values from Coolify and redeploy so the plaintext bootstrap password
does not remain in the container environment.

The web and platform images proxy `/api/*` to the private `api:3000` service.
The web image serves the public application on `www`, redirects the apex and
`admin` hostnames to `www`, and serves the workspace application at the root of
each tenant subdomain. Browser API requests therefore remain same-origin.

## PostgreSQL setup

Provision the control database and financial shard independently from this
application stack. They may be Coolify database resources or externally managed
PostgreSQL instances, but neither should have a public port unless access is
restricted to explicitly trusted sources.

The control database uses the `DATABASE_*` application role. The financial shard
uses two distinct roles:

- `FINANCIAL_DATABASE_MIGRATION_USER` owns and migrates the financial schema.
- `FINANCIAL_DATABASE_USER` is the runtime API role. It must not be a superuser,
  own the migrated tables, or have `BYPASSRLS`.

Set all values from `.env.example` in Coolify. The API readiness endpoint checks
both database connections. A deployment cannot become healthy when either
database is missing, unreachable, or has invalid credentials.

## Bootstrap

The committed zero-SHA image tags are validation placeholders and must never be
deployed.

1. Commit this workflow and Compose model to `arz-neshan-infra/main` before
   enabling the app release workflows; `repository_dispatch` only runs workflows
   present on the default branch.
2. Configure all GitHub secrets and ensure API and the frontend workspace are
   pushed to the source repositories listed in `release-state.json`.
3. Run or push `main` in both repositories. The first API release is gated
   because no deployed API SHA exists yet; review and merge its migration PR.
4. Confirm both zero-SHA release records were replaced and the exact API, web,
   and platform images can be pulled from the deployment server.
5. Provision both databases, Vault, SMTP, SMS gateway, and attachment storage;
   enter the production variables in Coolify.
6. Run both database migrations at the approved bootstrap point, then deploy and
   verify the application manually.
7. Only after a healthy manual deployment, enable automatic deployment for
   infra-repository pushes.

Validate the checked-out infra repository before connecting it to Coolify:

```sh
node scripts/validate-deployment.mjs
```

## Database migrations

Migrations never run during normal container startup. When migrations differ
from the last deployed API SHA, the infra workflow creates or refreshes one open
`deploy(api): migration-gated release` PR. Later API releases remain on that PR
until it is merged.

Before merging:

1. Review all new migration `up` and `down` operations.
2. Create and verify a restorable PostgreSQL backup.
3. Confirm the old and new application versions both tolerate the transition.
   Split incompatible changes into expand, application, and contract releases.

Every database-changing API release must be expand-and-contract compatible: the
old API, target API, and transitional schema must tolerate the chosen order. If
that is not true, split the change into separate releases. Do not merge the
migration-gated PR while automatic deployment is enabled unless this
compatibility has been explicitly verified.

At the approved bootstrap or release point, run both inactive migration jobs
from Coolify's deployment directory with the same environment Coolify uses:

```sh
docker compose -f compose.coolify.yml --profile migration run --rm migration
docker compose -f compose.coolify.yml --profile migration run --rm financial-migration
```

Confirm both jobs exit successfully before considering the database release
complete. On first bootstrap, migrations must be complete before public traffic
is attached. For an additive release where the target API can safely start on
the old schema, it may be deployed first and migrations run immediately after;
otherwise run the compatible expansion before deploying the target API.

Never run the demo seeder in production and never automatically reverse a
migration during image rollback.

## Verification and rollback

After deployment, verify public, tenant-workspace, and platform `/healthz`
endpoints, API `/api/health/live` and `/api/health/ready`, signup and login, a
clean attachment upload/download, and the recorded client IP.

To roll back, revert the relevant infra promotion commit or commit the previous
immutable image tag in both `compose.coolify.yml` and `release-state.json`.
For API rollback, keep `api`, `migration`, and `financial-migration` on the same
tag. Coolify deploys the revert like any other infra change. Retain registry
images long enough for the required rollback window. Never automatically reverse
a database migration during an image rollback.
