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
  JSON.stringify(defaultServices) === JSON.stringify(["api", "clamav"]),
  `Default deployment must contain only API dependencies; found: ${defaultServices.join(",")}`,
);

const serviceNames = ["api", "web", "platform", "clamav", "migration"];
const releaseServices = ["api", "frontends"];
const hardenedServices = ["api", "web", "platform", "migration"];

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
    service.read_only === true,
    `${serviceName} must have a read-only root filesystem.`,
  );
  assert(
    service.cap_drop?.includes("ALL"),
    `${serviceName} must drop all Linux capabilities.`,
  );
  assert(
    service.security_opt?.includes("no-new-privileges:true"),
    `${serviceName} must enable no-new-privileges.`,
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
