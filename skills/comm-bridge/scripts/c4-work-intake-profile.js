const AGENT_ID = /^agent:[a-z0-9][a-z0-9._-]{0,62}$/;
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,62}$/;

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseAliases(rawValue) {
  if (!optionalText(rawValue)) return [];
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new TypeError('ZYLOS_AGENT_ALIASES must be a JSON array');
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError('ZYLOS_AGENT_ALIASES must be a JSON array');
  }
  if (parsed.length > 32) throw new TypeError('ZYLOS_AGENT_ALIASES exceeds 32 entries');
  return parsed.map((alias) => {
    if (typeof alias !== 'string' || !alias.trim() || Array.from(alias.trim()).length > 64) {
      throw new TypeError('ZYLOS_AGENT_ALIASES must contain non-empty strings');
    }
    return alias.trim();
  });
}

/**
 * Resolve the runtime-neutral Agent identity used by C4 WorkIntake.
 * Feishu and other Channel Adapters consume the same ZYLOS_AGENT_ID; aliases
 * are only natural-language names and never replace the logical identity.
 */
export function workIntakeProfileFromEnv(env = process.env) {
  const profileId = optionalText(env.ZYLOS_AGENT_PROFILE)?.toLowerCase() || null;
  if (profileId && !PROFILE_ID.test(profileId)) {
    throw new TypeError('ZYLOS_AGENT_PROFILE is invalid');
  }
  const configuredAgentId = optionalText(env.ZYLOS_AGENT_ID);
  const derivedAgentId = profileId ? `agent:${profileId}` : null;
  const agentId = configuredAgentId || derivedAgentId;
  if (agentId && !AGENT_ID.test(agentId)) {
    throw new TypeError('ZYLOS_AGENT_ID must be a logical Agent identity');
  }
  if (configuredAgentId && derivedAgentId && configuredAgentId !== derivedAgentId) {
    throw new TypeError('ZYLOS_AGENT_ID conflicts with ZYLOS_AGENT_PROFILE');
  }

  const aliases = parseAliases(env.ZYLOS_AGENT_ALIASES);
  const label = optionalText(env.ZYLOS_AGENT_LABEL);
  if (label && Array.from(label).length > 64) {
    throw new TypeError('ZYLOS_AGENT_LABEL exceeds 64 characters');
  }
  if (label) aliases.push(label);
  if (profileId) aliases.push(profileId);
  const agentAliases = [...new Set(aliases)];
  if (agentAliases.length > 0 && !agentId) {
    throw new TypeError('Agent aliases require ZYLOS_AGENT_ID or ZYLOS_AGENT_PROFILE');
  }

  const configuredDefaultAssigneeId = optionalText(
    env.C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID,
  );

  return Object.freeze({
    // A message delivered to one managed Agent is work for that Agent unless
    // the deployment explicitly routes WorkIntake to another assignee.
    defaultAssigneeId: configuredDefaultAssigneeId ?? agentId,
    agentId,
    agentAliases: Object.freeze(agentAliases),
  });
}
