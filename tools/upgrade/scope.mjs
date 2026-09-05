import path from 'node:path';
export const COMPONENTS = ['core', 'feishu', 'hxa'];
export const repository = name => `HeXiaobo/zylos-${name === 'hxa' ? 'hxa-connect' : name}`;
export const version = target => target?.version || target?.packageVersion;
export function validateInstalled(installed) {
  for (const name of COMPONENTS) {
    const target = installed?.[name];
    if (target?.version && target?.packageVersion && target.version !== target.packageVersion) throw new Error(`${name}: conflicting versions`);
    if (target?.repo !== repository(name) || !/^[a-f0-9]{40}$/.test(target?.sha || '') || !version(target)) throw new Error(`${name}: verified installed repo/version/full SHA required`);
  }
  return installed;
}
export function selection(options, installed) {
  const only = options['--only'] || 'core';
  if (![...COMPONENTS, 'all'].includes(only)) throw new Error('Scope must be core, feishu, hxa or all');
  const components = only === 'all' ? [...COMPONENTS] : [only];
  for (const name of COMPONENTS) if (!components.includes(name) && options[`--${name}`]) throw new Error(`${name}: version option is outside authorized scope ${only}`);
  if (only !== 'all' || installed) validateInstalled(installed);
  return components;
}
export function assertScope(manifest) {
  const selected = manifest.upgradeScope?.components;
  if (!Array.isArray(selected) || selected.length !== 1 || !COMPONENTS.includes(selected[0])) throw new Error('Exactly one component must be authorized; all uses the existing pair workflow');
  validateInstalled(manifest.stable); validateInstalled(manifest.candidate);
  for (const name of COMPONENTS.filter(x => x !== selected[0])) {
    const a = manifest.stable[name], b = manifest.candidate[name];
    if (a.repo !== b.repo || a.sha !== b.sha || version(a) !== version(b)) throw new Error(`${name}: unselected component changed`);
  }
  return selected[0];
}
export function buildScopedCommand(manifest, { zylosDir, runtimeTarget, reportRoot, node = process.execPath } = {}) {
  const component = assertScope(manifest);
  const core = component === 'core' ? manifest.localValidationRepos?.core : manifest.operatorTools?.core?.directory;
  if (!path.isAbsolute(core || '') || !path.isAbsolute(zylosDir || '')) throw new Error('Absolute source and runtime directories required');
  const target = manifest.candidate[component];
  const env = { ZYLOS_DIR: zylosDir };
  let args;
  if (component === 'core') {
    env.ZYLOS_SELF_UPGRADE_REPO = target.repo;
    args = [path.join(core, 'cli/zylos.js'), 'upgrade', '--self', '--branch', target.sha, '--yes', '--json'];
  } else if (component === 'feishu') {
    args = [path.join(core, 'cli/zylos.js'), 'upgrade', 'feishu', '--repo', target.repo, '--branch', target.sha, '--yes', '--skip-eval', '--json'];
  } else {
    if (!runtimeTarget?.agent || !runtimeTarget.profileId || !runtimeTarget.hostname || !runtimeTarget.deploymentOrgLabel || !path.isAbsolute(reportRoot || '')) throw new Error('Fresh HXA identity and new absolute report root required');
    args = [path.join(core, 'scripts/upgrade-hxa-connect.js'), '--execute', '--repo', target.repo, '--sha', target.sha, '--version', version(target), '--agent', runtimeTarget.agent, '--org', runtimeTarget.deploymentOrgLabel, '--profile-id', runtimeTarget.profileId, '--hostname', runtimeTarget.hostname, '--release-id', manifest.releaseId, '--report-root', reportRoot];
  }
  return { component, preserved: COMPONENTS.filter(name => name !== component), command: node, args, env };
}
