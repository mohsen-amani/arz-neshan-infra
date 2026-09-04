# Arz Neshan production infrastructure

This repository is the production source of truth watched by Coolify. Application
repositories publish immutable images to the private registry and dispatch a
validated promotion event here. This repository records the selected image tags;
Coolify never builds application source.

## Release flow

```text
app pull request -> lint, tests, production build, container build
main push        -> publish sha-<commit> image
                 -> repository_dispatch(image_published)
                 -> update compose.coolify.yml
                 -> commit main, or open an API migration PR
                 -> Coolify observes the infra commit and deploys it
```

Images are kept separately so every source repository can release independently:

```text
regi.mohsenamani.com/arz-neshan-infra/api:sha-<commit>
regi.mohsenamani.com/arz-neshan-infra/admin:sha-<commit>
regi.mohsenamani.com/arz-neshan-infra/client:sha-<commit>
```

`release-state.json` records the source repository, source SHA, workflow run
number, and tag for each deployed service. The workflow rejects stale run numbers
and maps service names to fixed registry paths instead of trusting image names
from dispatch payloads.

## GitHub setup

Add these Actions secrets to each application repository. Organization secrets
restricted to the three repositories may be used instead of duplicating them.

| Secret                 | Value                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `REGISTRY_USERNAME`    | Username allowed to push to the three registry repositories                                  |
| `REGISTRY_PASSWORD`    | Registry password or token                                                                   |
| `INFRA_DISPATCH_TOKEN` | Fine-grained GitHub token restricted to `mohsen-amani/arz-neshan-infra` with Contents: write |

Add the public `TURNSTILE_SITE_KEY` Actions variable to the admin repository.
The admin Docker build deliberately fails when it is missing. Keep the matching
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

| Service  | Source repository                |
| -------- | -------------------------------- |
| `api`    | `mohsen-amani/arz-neshan-api`    |
| `admin`  | `mohsen-amani/arz-neshan-admin`  |
| `client` | `mohsen-amani/arz-neshan-client` |

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
4. Attach the client base and wildcard tenant domains to `client:8080`, the
   admin base and wildcard tenant domains to `admin:8080`, and the API domain,
   if required, to `api:3000`. Add matching wildcard DNS records and TLS
   coverage for the tenant domains.
5. Do not assign a domain or public port to `clamav` or `migration`.
6. Preserve `attachments_data` when local attachment storage is selected.

The three `PLATFORM_OWNER_*` values seed the first platform account only when
the platform-user table is empty. After the first account exists, remove those
bootstrap values from Coolify and redeploy so the plaintext bootstrap password
does not remain in the container environment.

The frontend containers serve their own SPA and proxy `/api/*` to the private
`api:3000` service, so browser API requests remain same-origin.

## Bootstrap

The committed zero-SHA image tags are validation placeholders and must never be
deployed.

1. Commit this workflow and Compose model to `arz-neshan-infra/main` before
   enabling the app release workflows; `repository_dispatch` only runs workflows
   present on the default branch.
2. Configure all GitHub secrets and connect the admin repository to
   `mohsen-amani/arz-neshan-admin`.
3. Run or push `main` in API, admin, and client. The first API release is gated
   because no deployed API SHA exists yet; review and merge its migration PR.
4. Confirm all three zero-SHA tags were replaced and all exact images can be
   pulled from the deployment server.
5. Only then connect Coolify and enable automatic deployment.

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

After the compatible image is deployed, run the inactive profile from Coolify's
deployment directory with the same environment Coolify uses:

```sh
docker compose -f compose.coolify.yml --profile migration run --rm migration
```

Never run the demo seeder in production and never automatically reverse a
migration during image rollback.

## Verification and rollback

After deployment, verify the client and admin `/healthz` endpoints, API
`/api/health/live` and `/api/health/ready`, login, password-reset email, a clean
attachment upload/download, and the recorded client IP.

To roll back, revert the relevant infra promotion commit or commit the previous
immutable image tag in both `compose.coolify.yml` and `release-state.json`.
For API rollback, keep `api` and `migration` on the same tag. Coolify deploys the
revert like any other infra change. Retain registry images long enough for the
required rollback window.
