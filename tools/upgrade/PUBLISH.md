# Publish a qualified fork release

The publisher owns version qualification. Consumers use a repository link or the
installer; they do not prepare publication ledgers or repeat a release canary.
All three repositories use the Core GitHub Release catalog. Source tags and
unqualified historical releases are excluded from the default channel.

1. With owner release authorization, freeze a complete Core/Feishu/HXA bundle
   using the existing release workflow. Run the repository tests, compatibility
   checks, install/upgrade/rollback checks and functional canary on each supported
   environment. Finish the final deployment gate on the canary host. A running
   transaction must reach a verified terminal state before another starts.
2. Keep the original qualification report and final gate receipt for each
   environment. The qualification report uses `zylos.release-qualification/v1`,
   `releaseId`, `status: PASS`, canonical `target` (each component has `repo`,
   `version`, full `sha`), `checkedAt`, `gateVersion: functional-canary-v2`,
   `environment`, and `environmentFingerprint`. It must summarize actual checks;
   an installed version or PM2 online alone is insufficient. The final gate must
   be a successful `deploy --stage final` receipt for this exact release/bundle.
3. The portable environment is `{platform, arch, nodeMajor, runtime,
   functionalConfigSha256}`. Supported values are linux/darwin, x64/arm64,
   Node major >= 20, claude/codex. Compute the configuration hash from canonical
   JSON of the tested non-secret functional settings. Record the precise setting
   fields and canonicalization in the release notes so consuming Agents can
   derive the same descriptor from actual configuration. Do not hash whole
   account configuration or copy a publisher fingerprint onto an unverified host.
   `release-channel.mjs` exports `canonical`, `sha256`, and
   `qualificationFingerprint` for both publisher and consumer. The descriptor
   itself is produced by `tools/upgrade/functional-config-probe.mjs`, which ships
   in this repository so a consumer can reproduce the published digest. Publish
   the command and the probe's repository path in the reviewed notes; do not paste
   a copy of the probe into the notes, because a consumer that runs a stale copy
   computes a different digest and loses the environment match. When the probe's
   descriptor schema changes, the digests change with it, so re-run the probe on
   each already-qualified host before the next publication.
4. Write reviewed public notes with the functional-configuration recipe from step 3,
   referencing `tools/upgrade/functional-config-probe.mjs` instead of embedding a copy.
   The publisher carries this file unchanged into the generated release notes.
   Create an external JSON array of `{ "report": "/absolute/report.json",
   "finalGate": "/absolute/final-gate.json" }` entries. Retain the authorized
   external publication ledger for the same bundle. Prepare the public asset:

   ```sh
   node tools/upgrade/publish.mjs --manifest /absolute/deployment-ledger.json --publication-manifest /absolute/publication-ledger.json --qualifications /absolute/index.json --notes-file /absolute/reviewed-notes.md --tag bundle-RELEASE_ID --out /absolute/new-publication-directory
   ```

   The tag must already exist and resolve to the qualified Core SHA. It is a
   bundle identity, independent of component version numbering. Preparation
   requires successful release qualification and the existing publication gate.
   It writes a reviewable `zylos-release.json`, notes and gate receipt without
   publishing or changing a runtime. Public evidence includes hashes and an
   allowlist of portable fields; raw messages, host/profile IDs, credentials and
   local paths stay private.
5. After publication is authorized, run the same command with a **new output
   directory** and `--execute`. The tool rechecks the gates, creates a draft with
   the asset, verifies its bytes and tag, then publishes. An uncertain mutation
   is read back before reporting success. `PUBLICATION_PENDING` is not published;
   retain its release ID and inspect it before a retry. Repeating with identical
   evidence recognizes the existing release; conflicting evidence is never
   overwritten. Do not manually publish a failed draft.

## Adding a host environment to a published release

The qualification matrix grows as hosts appear; a release identity and its bundle never
change. When a host environment is not yet in the matrix, qualify it on that host, keep
its qualification report and its successful `deploy --stage final` receipt for the same
release, add the entry to the external index, and re-run the same publication command
with the same tag plus `--append-qualifications`:

```sh
node tools/upgrade/publish.mjs --manifest /absolute/deployment-ledger.json \
  --publication-manifest /absolute/publication-ledger.json \
  --qualifications /absolute/index.json --notes-file /absolute/reviewed-notes.md \
  --tag bundle-RELEASE_ID --out /absolute/new-publication-directory \
  --append-qualifications [--execute]
```

The tag already exists, so the tool replaces the asset instead of creating a release.
Replacement is accepted only when the new asset keeps the same release ID, tag and bundle
and still contains every already-published qualification byte-identical, and adds at
least one new environment. Anything else is refused and the published asset is left
untouched; the strict overwrite rule still applies without the flag. Update the reviewed
notes in the same call so they describe the enlarged matrix, and keep one index entry per
qualified environment.

The channel defaults to stable, requiring all bundle versions to be stable.
Preview requires explicit `--channel preview`, CLI `--beta`, or an exact RC
version. Preview still requires qualification. Consumers verify GitHub's asset
SHA256/size, tag commit, bundle and environment, and pin full commits before
installation. API/download failures never select tags or main as a fallback.
Single-component preparation requires qualification with the installed companion
SHAs. No matching release means the publisher needs to qualify that combination.

The first release after adopting this workflow must actually complete these
checks and publish an asset. Installing this code does not certify old releases
or turn an existing HOLD into PASS. Repository versions are changed only by the
existing authorized release workflow.

## Correcting published release notes

The published body is documentation; the qualification asset is the contract. When a
published note is wrong — for example it embeds a probe that no longer reproduces the
published digests — correct the body without touching the release asset:

```sh
node tools/upgrade/publish.mjs --manifest /absolute/deployment-ledger.json \
  --publication-manifest /absolute/publication-ledger.json \
  --qualifications /absolute/index.json --notes-file /absolute/corrected-notes.md \
  --tag bundle-RELEASE_ID --out /absolute/new-publication-directory \
  --correct-notes [--execute]
```

The command rebuilds the same asset from the same evidence and requires it to stay
byte-identical to the published one; a correction can never add or change a
qualification, and `--correct-notes` cannot be combined with
`--append-qualifications`. Identical notes are refused as a no-op, and the body is read
back and compared before success is reported, so an unapplied edit is never reported as
done. Record the corrected notes hash with the release evidence.
