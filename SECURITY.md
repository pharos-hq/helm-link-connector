# Security Policy

## Supported release

Security fixes are supported for the latest non-deprecated release of
`@pharos-hq/helm-link-connector`.

## Reporting

Do not open public issues containing vulnerabilities, enrollment commands,
credentials, customer data, host diagnostics, or configuration. Report security
issues privately through GitHub Security Advisories for this repository.

## Release integrity

Releases are published only by the tag-bound GitHub Actions workflow using npm
trusted publishing through OIDC with provenance. Maintainers must not publish
interactively, add an npm token, remove provenance, weaken the package allowlist,
or move a release tag.

