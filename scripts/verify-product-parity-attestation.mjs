import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function verifyProductParityAttestation(attestation, productSha, mirrorSha, version) {
  if (!SHA_PATTERN.test(productSha)) throw new Error("expected product SHA is invalid");
  if (!SHA_PATTERN.test(mirrorSha)) throw new Error("expected mirror SHA is invalid");
  if (!VERSION_PATTERN.test(version)) throw new Error("expected package version is invalid");

  const expected = {
    schema_version: 1,
    package: "sitepilot-mcp",
    version,
    parity: "passed",
    product_repository: "jim788e/sitepilot-mcp",
    product_sha: productSha,
    mirror_repository: "jim788e/sitepilot-mcp-npm",
    mirror_sha: mirrorSha,
  };
  if (!isDeepStrictEqual(attestation, expected)) {
    throw new Error("product parity attestation does not bind this exact product, mirror, and version");
  }
}

async function main() {
  const [attestationPath, productSha, mirrorSha, version] = process.argv.slice(2);
  if (!attestationPath || !productSha || !mirrorSha || !version) {
    throw new Error("Usage: node scripts/verify-product-parity-attestation.mjs <attestation> <product-sha> <mirror-sha> <version>");
  }
  const attestation = JSON.parse(await readFile(resolve(attestationPath), "utf8"));
  verifyProductParityAttestation(attestation, productSha, mirrorSha, version);
  console.log(`Verified authoritative product parity for sitepilot-mcp@${version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
