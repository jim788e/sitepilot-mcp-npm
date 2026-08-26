# Publishing `sitepilot-mcp`

The public mirror is the only npm publisher. Publication is fail-closed and requires all of the following:

1. `publish.yml` is dispatched from `main` for an unpublished version.
2. Mirror CI is green for the exact mirror commit.
3. The private authoritative product CI has a successful `npm-artifact-parity` job for the product SHA in `.sitepilot-product-source.json`.
4. The immutable product-CI artifact binds that product SHA to the exact mirror commit and package version being published.
5. The `npm` environment is approved by the Owner before its secrets and npm OIDC identity become available.

`PRODUCT_CI_READ_TOKEN` is an environment secret, never a repository secret. It must be a fine-grained token restricted to `jim788e/sitepilot-mcp` with only Metadata read and Actions read permissions. The environment accepts deployments only from `main`, requires the Owner as reviewer, and disables administrator bypass. Rotate or revoke the token at expiry; a missing or expired token blocks publication.

After publishing, manually run the product repository's `Published npm artifact parity` workflow. Its weekly schedule then continues comparing the registry artifact with the authoritative product source.
