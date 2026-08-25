# Agent and Deployment Profiles

Zylos Core is runtime-neutral and deployment-neutral by default. Profiles keep
identity and operator policy outside that default:

- **Agent Profile** identifies an agent instance such as `yueran`, `mylos`, or
  a COCO-managed employee. It does not enable policy.
- **Deployment Profile** explicitly selects operator-owned behavior for the
  machine or hosting environment.

An absent profile, or the value `default` / `none`, loads no bundled
deployment governance. Core never infers a profile from an agent name,
runtime, Feishu/OpenMax channel, hostname, or repository branch.

## Local configuration

Add profile selection to `~/zylos/.zylos/config.json` while preserving its
existing fields:

```json
{
  "profiles": {
    "agent": "mylos",
    "deployment": "3ai"
  }
}
```

The `3ai` Deployment Profile preserves the organization-specific Memory Sync
governance that previously lived in the Core default. Local agents that do not
need those rules should leave `profiles.deployment` unset.

## Managed hosting

COCO or another hosting platform can configure the same immutable Core build
per instance:

```bash
ZYLOS_AGENT_PROFILE=coco-agent-26
ZYLOS_DEPLOYMENT_PROFILE=3ai
```

Environment selection takes precedence over `config.json`. Both Claude and
Codex Memory Sync call the same resolver, so changing runtime does not change
the selected deployment policy.

## Failure behavior

Unknown, malformed, or path-like explicit profile ids fail closed. Memory Sync
must report the configuration error and stop instead of silently falling back
to the generic policy. An Agent Profile by itself never activates a Deployment
Profile. Missing or blank selection means no profile.

The selected Memory Sync addendum can be inspected without changing state:

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/deployment-profile.js
```

No output with exit code zero means the runtime-neutral default is active.
