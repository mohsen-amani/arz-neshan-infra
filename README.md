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

Deployment is intentionally incremental. With no Compose profile enabled,
`vault-agent`, `api`, and `clamav` start. The `web` and `platform` services use
the `frontends` profile and can be enabled later without replacing the API
resource.

## Release flow

```text
app pull request -> lint, tests, production build, container build
main push        -> publish sha-<commit> image
                 -> repository_dispatch(image_published)
                 -> update compose.coolify.yml
                 -> open or update an infra promotion PR
human review     -> merge the promotion PR
                 -> Coolify observes the merged infra commit and deploys it
```

The API and frontend workspace release independently. A frontend release updates
its two images atomically:

```text
regi.mohsenamani.com/arz-neshan/api:sha-<commit>
regi.mohsenamani.com/arz-neshan/web:sha-<commit>
regi.mohsenamani.com/arz-neshan/platform:sha-<commit>
```

`release-state.json` records the source repository, source SHA, workflow run
number, and tag for each deployed service. The workflow rejects stale run numbers
and maps service names to fixed registry paths instead of trusting image names
from dispatch payloads.

`scripts/validate-deployment.mjs` verifies the fully rendered Compose model,
release metadata/image consistency, production safety flags, the absence of host
port mappings and source builds, the Vault Agent authentication boundary, and
that the API migration job uses the exact API image selected for deployment.

## GitHub setup

Add the registry credentials to the API, frontend, and infra repositories. Add
the dispatch token only to the API and frontend repositories. Organization
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

The infra workflow uses its repository-scoped `GITHUB_TOKEN`. Keep its default
permission read-only and allow GitHub Actions to create and approve pull requests.
The promotion workflow explicitly requests only the write permissions it needs.

This private repository uses GitHub Free, so branch protection cannot be
enforced. Promotion workflows never push directly to `main`. Review and merge
every promotion PR manually, and avoid manual direct pushes to `main`.

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
2. Leave `COMPOSE_PROFILES` unset for the first API-only deployment. Enable
   automatic deployment for infra-repository pushes after bootstrap succeeds.
3. Copy `.env.example` into Coolify's environment editor and replace every
   placeholder. Mark database, JWT, Turnstile, SMS, internal-jobs, HesabPay,
   platform-owner, SMTP, S3, and Vault AppRole credentials as secrets.
4. For the API-first deployment, attach only the exact API hostname to
   `api:3000`. Do not expose ClamAV or the migration job.
5. Do not assign a domain or public port to `clamav` or `migration`.
6. Preserve `attachments_data` when local attachment storage is selected.

Do not select the Dockerfile build pack and do not paste the Compose definition
into a source-less Coolify Service. The Git repository is the canonical Compose
definition and its commits are the deployment history.

The three `PLATFORM_OWNER_*` values seed the first platform account only when
the platform-user table is empty. After the first account exists, remove those
bootstrap values from Coolify and redeploy so the plaintext bootstrap password
does not remain in the container environment.

When the `frontends` profile is enabled, the web and platform images proxy
`/api/*` to `api:3000`. The web image serves the public application on `www`,
redirects the apex and `admin` hostnames to `www`, and serves the workspace
application at the root of each tenant subdomain. Browser API requests therefore
remain same-origin.

## PostgreSQL setup

Provision the PostgreSQL database independently from this application stack. It
may be a Coolify database resource or an externally managed PostgreSQL instance,
but it should not have a public port unless access is restricted to explicitly
trusted sources.

The API and migration job use the `DATABASE_*` settings from `.env.example`.
The API readiness endpoint checks the configured database connection, so a
deployment cannot become healthy when it is missing, unreachable, or has invalid
credentials.

## Vault Transit authentication

Vault runs as an independently managed service. The application stack connects
to its public, trusted HTTPS endpoint but never receives a root token or a static
operator token.

Enable AppRole and create an `arz-neshan-api` role bound only to the
`arz-neshan-api` Transit policy. Configure that role to issue renewable service
tokens with `token_num_uses=0`; Vault Agent auto-auth does not support tokens
with a limited number of uses.

Store the resulting values only in Coolify's protected runtime environment:

```text
VAULT_ADDR=https://vault.example.com
VAULT_ROLE_ID=<AppRole role ID>
VAULT_SECRET_ID=<AppRole secret ID>
```

Keep these as runtime-only variables. Disable Coolify's **Use Build Secrets**
setting for this application: every service pulls a prebuilt image, so there is
no application build stage that should receive deployment credentials.

Do not define `VAULT_TOKEN`. Compose exposes the AppRole credential values only
to `vault-agent` as secret files. The agent authenticates, renews its periodic
token, and writes it to the memory-backed `vault_agent_token` volume. The API
mounts that volume read-only and reads the current value through
`VAULT_TOKEN_FILE` on every Transit operation. The API waits for the agent's
token-file health check before starting.

The Agent HCL is embedded as a Compose `config`. Keep it inline: Coolify's
processed deployment directory contains the Compose model but does not reliably
copy auxiliary repository files referenced by relative bind mounts.

The Vault Agent container deliberately does not use a read-only root filesystem.
Docker Compose must materialize its environment-backed AppRole secrets as files.
The service still runs as the API's unprivileged UID, drops all Linux
capabilities, enables `no-new-privileges`, and has no public port.

`VAULT_AGENT_IMAGE` must remain pinned to an explicit reviewed version. The
example value is not an instruction to upgrade the independently deployed Vault
server without following Vault's upgrade guidance.

## API-first bootstrap

The committed zero-SHA image tags are validation placeholders and must never be
deployed.

1. Commit this workflow and Compose model to `arz-neshan-infra/main` before
   enabling the app release workflows; `repository_dispatch` only runs workflows
   present on the default branch.
2. Configure `REGISTRY_USERNAME`, `REGISTRY_PASSWORD`, and
   `INFRA_DISPATCH_TOKEN` in `arz-neshan-api`, then push its `main` branch. The
   first API release is migration-gated; review and merge its infra PR.
3. Confirm the API zero-SHA record was replaced and pull that exact image from
   the deployment server. The frontend release may remain at its zero-SHA state.
4. Provision the production database, Vault, SMTP, SMS gateway, and attachment
   storage; enter the production variables in Coolify.
5. Run the database migrations at the approved bootstrap point, then deploy and
   verify the application manually.
6. Attach `https://api.example.com:3000` to the `api` component and verify
   `/api/health/live` and `/api/health/ready`.
7. Only after a healthy manual deployment, enable automatic deployment for
   infra-repository pushes.

Validate the checked-out infra repository before connecting it to Coolify:

```sh
node scripts/validate-deployment.mjs
```

## Add the frontends later

1. Push `arz-neshan-frontends` and configure its registry/dispatch secrets plus
   the public `TURNSTILE_SITE_KEY` repository variable.
2. Push its `main` branch. Confirm one infra promotion updates both `web` and
   `platform` to the same frontend SHA and replaces the frontend zero-SHA state.
3. In Coolify, set `COMPOSE_PROFILES=frontends`, reload the Compose definition,
   and redeploy the same application.
4. Attach the apex, `www`, `admin`, and wildcard tenant hostnames to `web:8080`.
   Attach only the private operator hostname to `platform:8080`. Keep the exact
   API hostname attached directly to `api:3000`.
5. Add apex and proxied wildcard DNS records plus first-level wildcard TLS
   coverage. Ensure the exact API and platform routes win over the wildcard.

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

At the approved bootstrap or release point, run the inactive migration job
from Coolify's deployment directory with the same environment Coolify uses:

```sh
docker compose -f compose.coolify.yml --profile migration run --rm migration
```

Confirm the job exits successfully before considering the database release
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
For API rollback, keep `api` and `migration` on the same tag. Coolify deploys the
revert like any other infra change. Retain registry images long enough for the
required rollback window. Never automatically reverse a database migration
during an image rollback.
