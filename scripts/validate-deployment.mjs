import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const composeOutput = execFileSync(
  "docker",
  [
    "compose",
    "--env-file",
    ".env.example",
    "-f",
    "compose.coolify.yml",
    "--profile",
    "migration",
    "--profile",
    "frontends",
    "config",
    "--format",
    "json",
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);

const compose = JSON.parse(composeOutput);
const releaseState = JSON.parse(readFileSync("release-state.json", "utf8"));
const rawCompose = readFileSync("compose.coolify.yml", "utf8");

assert(
  !rawCompose.includes("!!merge"),
  "Compose must not contain explicit YAML merge tags; Coolify's parser does not handle them reliably.",
);

const defaultServices = execFileSync(
  "docker",
  [
    "compose",
    "--env-file",
    ".env.example",
    "-f",
    "compose.coolify.yml",
    "config",
    "--services",
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .sort();

assert(
  JSON.stringify(defaultServices) ===
    JSON.stringify(["api", "clamav", "vault-agent"]),
  `Default deployment must contain only API dependencies; found: ${defaultServices.join(",")}`,
);

const serviceNames = [
  "api",
  "web",
  "platform",
  "clamav",
  "migration",
  "vault-agent",
];
const releaseServices = ["api", "frontends"];
const hardenedServices = [
  "api",
  "web",
  "platform",
  "migration",
  "vault-agent",
];
const readOnlyServices = ["api", "web", "platform", "migration"];

for (const serviceName of serviceNames) {
  assert(
    compose.services?.[serviceName],
    `Missing Compose service: ${serviceName}`,
  );
}

assert(
  compose.services.api.image === compose.services.migration.image,
  "The API and migration job must use the same immutable image.",
);

const apiEnvironment = compose.services.api.environment;
for (const [key, expected] of Object.entries({
  NODE_ENV: "production",
  OTP_DEV_ECHO: "false",
  OTP_LOG_MODE: "false",
  SMS_GATEWAY_DISABLED: "false",
  HESABPAY_MOCK_MODE: "false",
})) {
  assert(
    apiEnvironment?.[key] === expected,
    `API production safeguard ${key} must equal ${expected}.`,
  );
}

assert(
  apiEnvironment?.VAULT_TOKEN_FILE === "/run/secrets/vault/token",
  "The API must read its renewable Vault token from the Agent sink file.",
);
assert(
  !["VAULT_TOKEN", "VAULT_ROLE_ID", "VAULT_SECRET_ID"].some(
    (key) => key in apiEnvironment,
  ),
  "The API must not receive static Vault tokens or Vault Agent AppRole credentials.",
);

const vaultAgent = compose.services["vault-agent"];
assert(
  vaultAgent.user === "10001:10001",
  "Vault Agent must share the API image's unprivileged UID and GID.",
);
assert(
  vaultAgent.environment?.VAULT_ADDR === apiEnvironment.VAULT_ADDR,
  "Vault Agent and the API must use the same Vault address.",
);
assert(
  !("VAULT_ROLE_ID" in vaultAgent.environment) &&
    !("VAULT_SECRET_ID" in vaultAgent.environment),
  "Vault AppRole credentials must be mounted as Compose secrets, not environment variables.",
);
assert(
  compose.secrets?.vault_role_id?.environment === "VAULT_ROLE_ID" &&
    compose.secrets?.vault_secret_id?.environment === "VAULT_SECRET_ID",
  "Vault AppRole credentials must be sourced from protected deployment variables.",
);

const agentSecretSources = new Set(
  (vaultAgent.secrets ?? []).map((secret) => secret.source),
);
assert(
  agentSecretSources.has("vault_role_id") &&
    agentSecretSources.has("vault_secret_id"),
  "Vault Agent must receive both AppRole credential files.",
);

const agentConfigMount = vaultAgent.configs?.find(
  (config) => config.target === "/vault/config/agent.hcl",
);
assert(
  agentConfigMount?.source === "vault_agent_config",
  "Vault Agent must mount its repository-independent inline Compose config.",
);

const tokenVolume = compose.volumes?.vault_agent_token;
assert(
  tokenVolume?.driver === "local" &&
    tokenVolume.driver_opts?.type === "tmpfs" &&
    tokenVolume.driver_opts?.device === "tmpfs",
  "The Vault Agent token volume must be memory-backed.",
);

const apiTokenMount = compose.services.api.volumes?.find(
  (volume) => volume.target === "/run/secrets/vault",
);
assert(
  apiTokenMount?.source === "vault_agent_token" &&
    apiTokenMount.read_only === true,
  "The API must mount the Agent token volume read-only.",
);
assert(
  compose.services.api.depends_on?.["vault-agent"]?.condition ===
    "service_healthy",
  "The API must wait for Vault Agent to write its initial token.",
);

const agentConfig = compose.configs?.vault_agent_config?.content;
assert(
  typeof agentConfig === "string" && agentConfig.length > 0,
  "The inline Vault Agent configuration must not be empty.",
);
for (const requiredSetting of [
  /type\s*=\s*"approle"/,
  /role_id_file_path\s*=\s*"\/run\/secrets\/vault_role_id"/,
  /secret_id_file_path\s*=\s*"\/run\/secrets\/vault_secret_id"/,
  /remove_secret_id_file_after_reading\s*=\s*false/,
  /path\s*=\s*"\/vault\/token\/token"/,
]) {
  assert(
    requiredSetting.test(agentConfig),
    `Vault Agent configuration is missing: ${requiredSetting}`,
  );
}

for (const [serviceName, service] of Object.entries(compose.services)) {
  assert(
    !service.build,
    `${serviceName} must pull an image instead of building source.`,
  );
  assert(
    !service.container_name,
    `${serviceName} must not set container_name.`,
  );
  assert(
    !service.ports || service.ports.length === 0,
    `${serviceName} must not publish a host port. Use a Coolify domain or expose instead.`,
  );
  assert(
    typeof service.image === "string" && !service.image.endsWith(":latest"),
    `${serviceName} must use an explicit image version.`,
  );
}

for (const serviceName of hardenedServices) {
  const service = compose.services[serviceName];
  assert(
    service.cap_drop?.includes("ALL"),
    `${serviceName} must drop all Linux capabilities.`,
  );
  assert(
    service.security_opt?.includes("no-new-privileges:true"),
    `${serviceName} must enable no-new-privileges.`,
  );
}

for (const serviceName of readOnlyServices) {
  assert(
    compose.services[serviceName].read_only === true,
    `${serviceName} must have a read-only root filesystem.`,
  );
}

assert(
  compose.volumes?.attachments_data,
  "Missing persistent attachments_data volume.",
);
assert(
  compose.volumes?.clamav_database,
  "Missing persistent clamav_database volume.",
);

const zeroTag = "sha-0000000000000000000000000000000000000000";

for (const serviceName of releaseServices) {
  const state = releaseState[serviceName];
  assert(state, `Missing release metadata for ${serviceName}.`);

  const expectedRepository = `mohsen-amani/arz-neshan-${serviceName}`;
  assert(
    state.source_repository === expectedRepository,
    `Invalid source repository for ${serviceName}: ${state.source_repository}`,
  );
  assert(
    Number.isInteger(state.source_run_number) && state.source_run_number >= 0,
    `Invalid source run number for ${serviceName}: ${state.source_run_number}`,
  );

  if (state.source_run_number === 0) {
    assert(
      state.source_sha === "" && state.tag === zeroTag,
      `Unpublished service ${serviceName} must retain the zero-SHA bootstrap state.`,
    );
  } else {
    assert(
      /^[0-9a-f]{40}$/.test(state.source_sha) &&
        state.tag === `sha-${state.source_sha}`,
      `Release metadata for ${serviceName} is not an immutable full-SHA release.`,
    );
  }

  const imageServices =
    serviceName === "frontends" ? ["web", "platform"] : ["api"];
  for (const imageService of imageServices) {
    const imageRepository = `regi.mohsenamani.com/arz-neshan/${imageService}`;
    const expectedImage = `${imageRepository}:${state.tag}`;
    assert(
      compose.services[imageService].image === expectedImage,
      `Compose image for ${imageService} does not match ${serviceName} release metadata.`,
    );
  }
}

execFileSync(
  "git",
  ["-c", `safe.directory=${repoRoot.replaceAll("\\", "/")}`, "diff", "--check"],
  { stdio: "inherit" },
);

console.log("Deployment model is valid.");
