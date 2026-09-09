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
   `qualificationFingerprint` for both publisher and consumer.
4. Create an external JSON array of `{ "report": "/absolute/report.json",
   "finalGate": "/absolute/final-gate.json" }` entries. Retain the authorized
   external publication ledger for the same bundle. Prepare the public asset:

   ```sh
   node tools/upgrade/publish.mjs --manifest /absolute/deployment-ledger.json --publication-manifest /absolute/publication-ledger.json --qualifications /absolute/index.json --tag bundle-RELEASE_ID --out /absolute/new-publication-directory
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
