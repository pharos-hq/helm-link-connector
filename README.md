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
- The deterministic `0.1.0` archive must have SHA-256
  `da7f10d733be9ec82b611e4033dc0db934f4f3d624f2bdc0024bf78b38463ff6`.
- `SOURCE_MANIFEST.json` pins every executable package source file.
- CI rejects source drift, archive drift, unexpected package contents, and
  unpinned release actions.

The package's `0.1.0` metadata retains the original reviewed repository field so
the published archive remains byte-for-byte identical to the audited candidate.
The GitHub provenance statement identifies this public repository and the exact
tag-bound release workflow as the actual publication source.

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
npx --yes '@pharos-hq/helm-link-connector@0.1.0' doctor --agent your-openclaw-agent-id
```

