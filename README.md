# Helm Link Connector

Canonical public source and release boundary for
`@pharos-hq/helm-link-connector`.

The connector runs on a customer's trusted OpenClaw host and communicates with
Pharos Helm over outbound HTTPS. The executable package surface is intentionally
limited to the eight files under `packages/helm-link-connector/`.

## Supply-chain controls

- Releases are accepted only from tags matching
  `helm-link-connector-v<package-version>`.
- npm publication uses GitHub OIDC trusted publishing with provenance.
- No npm token is accepted by the release workflow.
- The deterministic `0.1.3` archive must have SHA-256
  `e84906c9c16be899c662c0c13ecca555d746c4daa2e8589969c3446010339d33`.
- `SOURCE_MANIFEST.json` pins every executable package source file.
- CI rejects source drift, archive drift, unexpected package contents, and
  unpinned release actions.

The package metadata identifies this public repository, and the GitHub
provenance statement identifies the exact tag-bound release workflow and source
commit used for publication.

## Local verification

Requires Node.js 22:

```bash
npm test
```

This rebuilds the archive twice, verifies the exact eight-file allowlist and
SHA-256, checks the release workflow for tokenless OIDC controls, and runs the
installed CLI against a local OpenClaw fixture.

## Installation

Helm generates a private, version-pinned connection command. Never replace its
package version with `latest`, and never paste or screenshot an enrollment
credential.

The public, credential-free package check is:

```bash
npx --yes '@pharos-hq/helm-link-connector@0.1.3' doctor --agent your-openclaw-agent-id
```
