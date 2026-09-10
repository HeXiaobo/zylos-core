#!/usr/bin/env node
// Preparation only: no runtime installation or service mutations.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareManifest } from './governance/prepare-release.mjs';
import { selection, normalizeInstalled, version as installedVersion } from './scope.mjs';
import { resolveQualifiedRelease, parseVersion, compareVersions, readReleaseHost, qualificationFingerprint, environmentDescriptor, ENVIRONMENT_POLICIES } from './release-channel.mjs';
import { attachQualification } from './qualification.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_FIELDS = ['platform', 'arch', 'nodeMajor', 'runtime'];
const describeHost = environment => HOST_FIELDS.map(field => `${field}=${environment[field]}`).join(' ');
// A blocked preparation must say why every published release was rejected and
// which host environments are actually covered, so the operator or Agent can
// act without re-deriving the qualification matrix by hand.
export function describeResolutionFailure(error) {
  const lines = [error.message];
  if (error.host) lines.push(`Host environment: ${describeHost(error.host)}`);
  if (error.environmentFingerprint) lines.push(`Host environment fingerprint: ${error.environmentFingerprint}`);
  if (Array.isArray(error.skipped) && error.skipped.length) lines.push('Reviewed published releases:');
  for (const item of error.skipped || []) {
    lines.push(`- ${item.tag}: ${item.reason}`);
    for (const environment of item.environments || []) lines.push(`  qualified for: ${describeHost(environment)}`);
  }
  if (error.code === 'NO_QUALIFIED_RELEASE') {
    lines.push('Next: qualify and publish a release for this host environment, or run preparation on a host that matches a published qualification.');
    lines.push('If no release is qualified for this environment yet, generate the descriptor with tools/upgrade/functional-config-probe.mjs and prepare with --environment plus --environment-policy newest-qualified. That keeps the verified bundle but forbids reusing published evidence: this host must run its own complete local canary before deployment.');
  }
  return lines.join('\n');
}
// Kept as exports for consumers of the original preparation API.
export { compareVersions } from './release-channel.mjs';
export function prepare(options, { resolveRelease = resolveQualifiedRelease } = {}) {
  const output = options['--out'];
  if (!path.isAbsolute(output || '') || !options['--authorization-ref']) throw new Error('New absolute --out and --authorization-ref required');
  if (!['preview', 'stable'].includes(options['--channel'] || 'stable')) throw new Error('Unknown channel');
  for (const name of ['core', 'feishu', 'hxa']) {
    const requested = options[`--${name}`] || 'latest';
    if (requested !== 'latest') parseVersion(requested.replace(/^v/, ''));
  }
  const installed = options['--installed'] ? normalizeInstalled(JSON.parse(fs.readFileSync(options['--installed'], 'utf8'))) : undefined;
  const components = selection(options, installed);
  // mkdir is exclusive: never overwrite or reuse a partial/active transaction.
  fs.mkdirSync(output, { mode: 0o700 });
  const selector = components.length === 3 ? 'core' : components[0];
  const versions = Object.fromEntries(components.map(name => [name, options[`--${name}`] || 'latest']));
  const explicitPreview = Object.values(versions).some(value => value !== 'latest' && parseVersion(value.replace(/^v/, '')).pre);
  const environmentPolicy = options['--environment-policy'] || 'matched';
  if (!ENVIRONMENT_POLICIES.includes(environmentPolicy)) throw new Error('Invalid arguments; use --help');
  const environment = options['--environment']
    ? environmentDescriptor(JSON.parse(fs.readFileSync(options['--environment'], 'utf8'))) : undefined;
  if (environmentPolicy === 'newest-qualified' && !environment) throw new Error('--environment-policy newest-qualified needs --environment so the uncovered host can be bound to this preparation');
  const published = resolveRelease({ component: selector, components, installed, versions, environment, host: readReleaseHost(),
    environmentPolicy, requested: versions[selector], channel: options['--channel'] || (explicitPreview ? 'preview' : 'stable') });
  // A host the published matrix covers must import the published qualification: the
  // deployment gate rejects a covered host whose qualification was not imported, so a
  // preparation without --environment could only ever produce an undeployable manifest.
  // Fail here with the exact command instead of leaving the consumer at that dead end.
  if (!environment && published.environmentVerified) {
    throw new Error('This host environment is covered by the published qualification matrix, so the published qualification must be imported before deployment. Generate the descriptor with tools/upgrade/functional-config-probe.mjs and pass its output file as --environment.');
  }
  // Preserve newer installed versions. A named downgrade needs its own
  // explicit workflow; ordinary latest preparation must never do one.
  for (const name of components) {
    if (installed && compareVersions(installedVersion(installed[name]), published.document.bundle[name].version) > 0) {
      throw new Error(`${name}: installed version is newer than the verified release; kept installed sources, no downgrade prepared`);
    }
  }
  const source = path.join(output, 'source'); fs.mkdirSync(source);
  const repositories = {}, candidate = {};
  for (const name of ['core', 'feishu', 'hxa']) {
    const repo = `HeXiaobo/zylos-${name === 'hxa' ? 'hxa-connect' : name}`;
    const cwd = path.join(source, name); repositories[name] = cwd;
    execFileSync('git', ['clone', '--no-checkout', `https://github.com/${repo}.git`, cwd], { stdio: 'inherit' });
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    const selected = components.includes(name) ? published.document.bundle[name] : installed[name];
    const sha = selected.sha;
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`${name}: invalid commit SHA`);
    git('merge-base', '--is-ancestor', sha, 'origin/main');
    if (installed && components.includes(name) && installed[name].sha !== sha
        && compareVersions(installedVersion(installed[name]), installedVersion(selected)) === 0) {
      try { git('merge-base', '--is-ancestor', installed[name].sha, sha); }
      catch { throw new Error(`${name}: same-version installed source is newer or divergent; no downgrade prepared`); }
    }
    const pkg = JSON.parse(git('show', `${sha}:package.json`));
    if (pkg.version !== installedVersion(selected) || pkg.name !== (name === 'core' ? 'zylos' : `zylos-${name === 'hxa' ? 'hxa-connect' : name}`)) throw new Error(`${name}: tag/package mismatch`);
    git('switch', '-c', `release/${pkg.version}`, sha);
    if (git('status', '--porcelain')) throw new Error(`${name}: dirty source`);
    candidate[name] = { repo, branch: 'main', sha, [name === 'hxa' ? 'packageVersion' : 'version']: pkg.version };
  }
  fs.cpSync(path.join(HERE, 'governance'), path.join(output, 'governance'), { recursive: true });
  for (const file of ['scope.mjs', 'command.mjs', 'qualification.mjs', 'release-channel.mjs']) fs.copyFileSync(path.join(HERE, file), path.join(output, file));
  fs.copyFileSync(path.join(HERE, 'WORKFLOW.md'), path.join(output, 'WORKFLOW.md'));
  fs.copyFileSync(path.join(HERE, '../../UPGRADE.md'), path.join(output, 'UPGRADE.md'));
  const releaseId = `ZYL-UPGRADE-${os.hostname().replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;
  const previous = { releaseId: null, owner: 'HeXiaobo', stable: installed || {},
    sourcePolicy: { deployableBranch: 'main', immutableFullShaOnly: true, featureReleaseArchiveBranchesAreHistoryOnly: true },
    deploymentContract: { targetMode: 'global', rolloutMode: 'CANARY', immutableFullShaOnly: true, cleanWorktreeRequired: true, dryRunRequired: true, pairReportRequired: true, canaryRequired: true, pairComponents: ['core', 'feishu'], hxaRequired: true } };
  let manifest = prepareManifest(previous, { releaseId, targets: candidate, repositories, authorizationRef: options['--authorization-ref'] });
  const toolDirectory = path.resolve(HERE, '../..');
  const toolSha = execFileSync('git', ['-C', toolDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  manifest.operatorTools = { core: { repo: 'HeXiaobo/zylos-core', directory: toolDirectory, sha: toolSha } };
  manifest.upgradeScope = { components, preserved: ['core', 'feishu', 'hxa'].filter(name => !components.includes(name)) };
  const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(output, 'evidence'));
  const assetPath = path.join(output, 'evidence/published-release.json');
  fs.writeFileSync(assetPath, published.assetBytes, { flag: 'wx', mode: 0o600 });
  manifest.distribution = { releaseId: published.document.releaseId, channel: published.document.channel,
    assetPath, assetSha256: published.assetSha256, qualificationImported: false };
  if (environment && published.environmentVerified) {
    manifest = attachQualification(manifest, { assetPath, assetSha256: published.assetSha256,
      environment, evidenceDirectory: path.join(output, 'evidence') });
  } else if (environment) {
    // The chosen release is qualified, but not for this host environment. Nothing
    // from the publisher can be reused here, so the deployment contract stays at
    // the local CANARY workflow and the host must produce its own full evidence.
    manifest.distribution = { ...manifest.distribution, qualificationImported: false, environmentVerified: false,
      localEvidenceRequired: 'fully-local-canary', hostEnvironment: environment,
      hostEnvironmentFingerprint: qualificationFingerprint(environment),
      unverifiedReason: `no published qualification covers ${describeHost(environment)}` };
  }
  write('bundle.json', { ...previous, releaseId, candidate, upgradeScope: manifest.upgradeScope });
  write('governance/release-manifest.json', manifest);
  write('governance/employee-runtime-registry.json', { schema: 'zylos.employee-runtime-registry/v1', employees: {} });
  const environmentVerified = published.environmentVerified;
  return { status: 'PREPARED', directory: output, releaseId, candidate, upgradeScope: manifest.upgradeScope, deploymentAllowed: false, runtimeMutation: false, environmentVerified, distribution: manifest.distribution, next: environmentVerified
    ? 'Read WORKFLOW.md; import matching published qualification, then run local host checks and supported upgrade.'
    : 'Read WORKFLOW.md; this host environment has no published qualification, so no published evidence may be reused. Run the complete local evidence workflow (identity, backup, source, dry run, canary) before deployment.' };
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.includes('--help')) {
      console.log('node tools/upgrade/prepare.mjs --out NEW_ABSOLUTE_DIR --authorization-ref MESSAGE_ID [--only core|feishu|hxa|all] [--installed VERIFIED_BASELINE_JSON] [--core latest|VERSION] [--feishu latest|VERSION] [--hxa latest|VERSION] [--channel stable|preview] [--environment VERIFIED_HOST_ENVIRONMENT_JSON] [--environment-policy matched|newest-qualified]');
    } else {
      for (let i = 0; i < args.length; i += 2) {
        if (!['--out', '--authorization-ref', '--core', '--feishu', '--hxa', '--channel', '--only', '--installed', '--environment', '--environment-policy'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error('Invalid arguments; use --help');
        options[args[i]] = args[i + 1];
      }
      console.log(JSON.stringify(prepare(options), null, 2));
    }
  } catch (error) { console.error(describeResolutionFailure(error)); process.exitCode = 1; }
}
