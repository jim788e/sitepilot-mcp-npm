import assert from "node:assert/strict";
import test from "node:test";
import { verifyProductParityAttestation } from "./verify-product-parity-attestation.mjs";

const productSha = "1".repeat(40);
const mirrorSha = "2".repeat(40);
const version = "0.1.3";

function attestation(overrides = {}) {
  return {
    schema_version: 1,
    package: "sitepilot-mcp",
    version,
    parity: "passed",
    product_repository: "jim788e/sitepilot-mcp",
    product_sha: productSha,
    mirror_repository: "jim788e/sitepilot-mcp-npm",
    mirror_sha: mirrorSha,
    ...overrides,
  };
}

test("publisher accepts only an exact authoritative parity binding", () => {
  assert.doesNotThrow(() => verifyProductParityAttestation(attestation(), productSha, mirrorSha, version));
  assert.throws(
    () => verifyProductParityAttestation(attestation({ product_sha: "3".repeat(40) }), productSha, mirrorSha, version),
    /does not bind/,
  );
  assert.throws(
    () => verifyProductParityAttestation(attestation({ mirror_sha: "4".repeat(40) }), productSha, mirrorSha, version),
    /does not bind/,
  );
  assert.throws(
    () => verifyProductParityAttestation(attestation({ version: "0.1.2" }), productSha, mirrorSha, version),
    /does not bind/,
  );
  assert.throws(
    () => verifyProductParityAttestation(attestation({ parity: "failed" }), productSha, mirrorSha, version),
    /does not bind/,
  );
});
