# Publishing `sitepilot-mcp`

The public mirror is the only npm publisher. Publication is fail-closed and requires all of the following:

1. `publish.yml` is dispatched from `main` for an unpublished version.
2. Mirror CI is green for the exact mirror commit.
3. The private authoritative product CI has a successful `npm-artifact-parity` job for the product SHA in `.sitepilot-product-source.json`.
4. The immutable product-CI artifact binds that product SHA to the exact mirror commit and package version being published.
5. The `npm` environment is approved by the Owner before its secrets and npm OIDC identity become available.

## Required order

The attestation binds one product commit to one exact mirror commit. Follow this order without inserting another mirror commit:

1. Merge the mirror release change, including `.sitepilot-product-source.json`, to `main`.
2. Run product CI for the product SHA named in that file. The parity job compares against the now-final mirror `main` commit and writes its SHA into the attestation.
3. Publish from that same mirror `main` commit.

Any commit to mirror `main` after step 2 invalidates the attestation, including a commit that changes `.sitepilot-product-source.json`. If either repository changes, repeat the parity run and use the new attestation. Product CI retains the attestation for 30 days; an expired artifact also requires a fresh parity run.

`PRODUCT_CI_READ_TOKEN` is an environment secret, never a repository secret. It must be a fine-grained token restricted to `jim788e/sitepilot-mcp` with only Metadata read and Actions read permissions. The environment accepts deployments only from `main`, requires the Owner as reviewer, and disables administrator bypass. Rotate or revoke the token at expiry; a missing or expired token blocks publication.

Mirror `main` must also be protected before publication: require pull requests and the mirror CI checks, and block force pushes and branch deletion. Environment approval protects the publish job; branch protection protects the trust anchor and publisher workflow that job reads.

After publishing, manually run the product repository's `Published npm artifact parity` workflow. Its weekly schedule then continues comparing the registry artifact with the authoritative product source.
