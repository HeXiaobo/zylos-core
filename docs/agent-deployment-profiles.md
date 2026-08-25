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

Do not replace the whole `profiles` object with a generic `zylos config set`
command. Before installing a candidate Core, use the candidate's nested,
atomic writer; it preserves all other `config.json` and `profiles` fields:

```bash
ZYLOS_DIR="$HOME/zylos" node /path/to/candidate/skills/zylos-memory/scripts/deployment-profile.js \
  set --agent mylos --deployment 3ai
```

For the existing 玥然 deployment, the equivalent explicit compatibility
selection is:

```bash
ZYLOS_DIR="$HOME/zylos" node /path/to/candidate/skills/zylos-memory/scripts/deployment-profile.js \
  set --agent yueran --deployment 3ai
```

Run this preflight against the live `ZYLOS_DIR` before upgrading. The old Core
ignores these new nested keys, while the new Core reads them on first start.
Back up the resulting `.zylos/config.json`, verify it still contains all
unrelated settings, then install/restart the runtime.

## Managed hosting

COCO or another hosting platform can configure the same immutable Core build
per instance:

```bash
ZYLOS_AGENT_PROFILE=coco-agent-26
ZYLOS_DEPLOYMENT_PROFILE=3ai
```

When WorkIntake should recognize and assign the same logical Agent, configure
its explicit identity seam as well (for example in the runtime supervisor or
the deployment's `.env`):

```bash
ZYLOS_AGENT_ID=agent:coco-agent-26
ZYLOS_AGENT_LABEL='员工 26'
ZYLOS_AGENT_ALIASES='["员工26"]'
C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID=agent:coco-agent-26
```

Environment selection takes precedence over `config.json`. Both Claude and
Codex clean environments retain the profile and WorkIntake identity variables
above, whether supplied by the supervisor or the deployment `.env`. Both
Memory Sync trigger paths mechanically resolve
the same governance file and bind its path plus SHA-256 digest into the sync
request, so changing runtime does not change the selected deployment policy.

`profiles.agent` / `ZYLOS_AGENT_PROFILE` is shared instance metadata, but does
not by itself define platform identity. WorkIntake's logical Agent id and
natural-language aliases are explicit runtime configuration; Feishu `open_id`
resolution and logical-id-to-platform mapping remain Feishu adapter concerns.

## Failure behavior

Unreadable/malformed config, unknown profiles, path-like ids, and profile files
that escape the bundled profile root fail closed. Memory Sync
must report the configuration error and stop instead of silently falling back
to the generic policy. An Agent Profile by itself never activates a Deployment
Profile. Missing or blank selection means no profile.

The selected Memory Sync addendum can be inspected without changing state:

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/deployment-profile.js
```

No output with exit code zero means the runtime-neutral default is active.
