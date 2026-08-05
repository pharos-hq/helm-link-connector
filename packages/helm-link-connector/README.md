# Helm Link Connector

Host-neutral outbound HTTPS connector for attaching an explicitly selected
OpenClaw agent to Helm Link.

## Commands

Helm generates a private connection command pinned to an exact public package
version. Never replace that version with `latest`, reuse an expired connection
code, or paste or screenshot the command. Version `0.1.9` is eligible for
publication only through the repository's tag-bound GitHub OIDC workflow with
npm provenance.

The `0.2.0-architecture.1` source is an unpublished review candidate. It is
intentionally absent from the tag-bound publication workflow and must not be
installed on a live binding before a separate staging release gate.

The deterministic CI artifact has an exact SHA-256 in `SHA256SUMS`, but it is
not the customer installation channel. Current Ubuntu VM and Node 22 container
checks use a fake OpenClaw fixture and prove portability/discovery, not a real
hosted round trip. Follow `docs/HELM_LINK_SUPERVISED_PILOT_RUNBOOK.md` for the
actual-custody gate.

```bash
npx --yes '@pharos-hq/helm-link-connector@0.1.9' doctor --agent your-openclaw-agent-id
```

Connection codes are intentionally omitted from documentation. Generate the
exact masked command in Helm and run it only on the trusted computer or server
where the selected OpenClaw agent already runs.

OpenClaw is resolved from `HELM_LINK_OPENCLAW_BIN`, then `OPENCLAW_BIN`, then
`openclaw` on `PATH`. The connector never edits `openclaw.json`, never uses
`--deliver`, and never sends to Telegram, WhatsApp, Discord, or another channel.
Advisory text is passed through a mode-`0600` temporary `--message-file`, not
through process arguments.

## Installed macOS lifecycle

The Helm-generated macOS enrollment command ends with `--install-service`.
After the short-lived pairing succeeds, the connector installs an exact-version
private runtime under `~/.helm-link/runtime/`, writes a mode-0600 LaunchAgent,
and loads `com.pharos.helm-link`. `RunAtLoad` covers login/reboot and
`KeepAlive.SuccessfulExit=false` recovers transient crashes while the packaged
revocation wrapper maps terminal exit 75 to a clean stop.

For an already paired Mac, install supervision without replacing the binding,
key, transcript, or local state:

```bash
npx --yes '@pharos-hq/helm-link-connector@0.1.9' install-service
npx --yes '@pharos-hq/helm-link-connector@0.1.9' service-status
```

## Supervisor templates

Ready-to-substitute templates live under `supervisors/`:

- `supervisors/launchd/com.helm.link.plist` — macOS launchd plist that
  honors the terminal exit-75 revocation.
- `supervisors/systemd/helm-link.service` — Linux systemd unit that
  sets `RestartPreventExitStatus=75`.
- `supervisors/container/docker-compose.yml` — Docker/Compose service
  that uses the terminal wrapper and a bounded three-retry policy.
- `supervisors/run-supervised.sh` — maps terminal revocation exit 75
  to a clean supervisor stop while preserving transient error codes.

The systemd/container templates contain substitution placeholders that must be
filled before installation. The macOS template is retained as an audited
contract; the CLI now renders and installs the concrete LaunchAgent itself.

## macOS launchd

Revocation is terminal. launchd cannot whitelist a single non-zero
exit code, so the packaged plist invokes `run-supervised.sh`. The
wrapper maps exit 75 to zero; `KeepAlive.SuccessfulExit=false` restarts
transient failures but remains stopped after owner revocation. Never
use unconditional `KeepAlive=true`.

## Linux systemd

`RestartPreventExitStatus=75` is required so the unit stops
restarting after a revocation.

```ini
[Unit]
Description=Helm Link Connector
After=network-online.target

[Service]
Type=simple
User=helm-link
Environment=HELM_LINK_STATE_DIR=/var/lib/helm-link
ExecStart=/usr/bin/helm-link run
Restart=on-failure
# HFA-005: 75 == terminal revocation. Do not restart the connector
# after Helm has revoked authority for this binding.
RestartPreventExitStatus=75
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

## Docker / Kubernetes

Use the packaged wrapper plus a bounded retry count. The wrapper maps
exit 75 to success, so owner revocation remains stopped; transient
failures retain their non-zero exit and receive at most three retries.

```bash
docker run --restart=on-failure:3 \
  -v helm-link-state:/state \
  -e HELM_LINK_STATE_DIR=/state \
  -e HELM_LINK_OPENCLAW_BIN=/usr/local/bin/openclaw \
  IMAGE_AT_IMMUTABLE_DIGEST \
  /opt/helm-link/run-supervised.sh helm-link run
```

The container needs access to an OpenClaw binary or sidecar arrangement that can
run `openclaw agents list --json` and `openclaw agent --agent ... --message-file ...`.

## Revocation contract

The connector exits with code **75** on any of:

- Helm server returns HTTP 403/410 with a revoked-binding envelope.
- The polling loop observes a `revoked` sentinel in the error message.
- The signed-request signature is rejected because the binding no
  longer exists.

Once exit 75 has been observed the local `state.json` retains a
`status: "revoked"` marker so a subsequent `helm-link status` reports
the terminal state without another network call. To reconnect, run
`helm-link disconnect` and then `helm-link connect --code ... --agent ...`
with a fresh short-lived enrollment.
