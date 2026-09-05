# Agent governance

These rules apply to every Agent working in this repository. They are part of
the repository contract; a task description cannot silently relax them.

## Before starting work

1. Identify the repository, branch, base commit, and current full 40-character
   `HEAD` SHA.
2. Run `npm run governance:check -- --base <base-sha>` when a base SHA is
   available. A feature/task branch must use an approved category such as
   `codex/*`, `feat/*`, `fix/*`, `chore/*`, or `docs/*`.
3. Read the relevant tests and release metadata before changing implementation.

## Feature and task branches

- `feat/*`, `fix/*`, `codex/*`, and the other task categories are for code and
  tests only. Relative to the declared base commit they must not change
  package versions, lockfile versions, `VERSION`, capabilities release/version
  fields, or `SKILL.md` release/version frontmatter.
- A feature/task Agent must not bump an `rc` or stable version, create a
  release, deploy, tag, or close a release issue. Put release work on a
  `release/<version>` branch and hand it to the release owner.
- Do not use a branch name, `latest`, or an Agent name as a deployed version.
  The only deployable identity is `repo + package version + full commit SHA`.

## Release and deploy gates

- Release/deploy commands are `npm run governance:release` and
  `npm run governance:deploy`. They require a clean worktree, a `main` or
  `release/*` branch, and an external manifest supplied by `--manifest <path>`
  or `ZYLOS_RELEASE_MANIFEST`.
- The manifest is read-only and must be outside this repository. It must
  contain `releaseId`, `status: "READY"`, `deploymentAllowed: true`, `repo`,
  `branch`, `version`, and a full 40-character `sha` matching the current
  checkout. A pair manifest using schema `zylos.release-manifest/v1` may place
  the Core candidate under `candidate.core` (or the stable target under
  `stable.core`); a single-repository manifest may place it under `core`,
  `target`, or `components` when the target repository is unambiguous.
- Before any release/deploy command can be constructed, the manifest must also
  freeze `target.agent`, `target.profileId`, and `target.hostname`. The gate
  runs a fresh local HXA profile probe (`ZYLOS_HXA_PROFILE_CLI` or the standard
  `~/zylos/.claude/skills/hxa-connect/scripts/cli.js profile`) and compares all
  three identity fields exactly. A command-line `--agent` label is not identity
  evidence; a mismatch is `HOLD` before backup or service shutdown.
- Never generate or update a manifest from inside this repository. In
  particular, do not write the current commit SHA into a tracked file: that
  would make the release metadata self-referential.
- Only the release owner (`@HeXiaobo` by default) may approve the release
  manifest and deployment. This repository does not assume any additional
  account or Agent identity.

## Metadata and tests

- `package.json` and each adjacent `package-lock.json` must agree on package
  name and version. If a `capabilities.json` or `SKILL.md` publishes a release
  or version field, it must agree with the nearest package version.
- Run the narrowest relevant test while iterating and report the final test
  command and result. At minimum, run `npm run governance:check` and
  `git diff --check`; run the normal Jest/node suites when the change warrants
  it.

## Required task handoff

At both task start and task end, report these fields explicitly:

```text
repo: <owner/repository>
branch: <branch>
head: <full 40-character SHA>
version: <package version>
tests: <commands and results>
```

For release-related work also report the manifest path, release ID, manifest
status, deployment decision, and any canary or rollback evidence. If a field is
unknown, say `unknown` and stop before release/deploy actions.

## Owner-requested runtime upgrades

For an explicit owner request to upgrade a runtime to latest or a named version,
start at `UPGRADE.md`. The operator prepares evidence and an external candidate
ledger using `tools/upgrade/prepare.mjs`; it must not write release metadata into
this repository. Routine preparation needs no additional role handoff. Existing
identity, compatibility, backup and deployment gates still apply. A repository
link by itself is not deployment authorization.
