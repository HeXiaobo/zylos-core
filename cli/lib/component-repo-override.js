/**
 * Validation for component upgrades sourced from an explicit GitHub commit.
 *
 * This is deliberately a small boundary module: callers get a normalized
 * immutable source tuple, while repository/ref validation stays out of the
 * download and metadata implementations.
 */

const GITHUB_NAME_PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

/**
 * Check a GitHub repository slug without accepting URLs or shell syntax.
 *
 * @param {unknown} repo
 * @returns {boolean}
 */
export function isValidGitHubRepository(repo) {
  if (typeof repo !== 'string') return false;
  const parts = repo.split('/');
  return parts.length === 2
    && GITHUB_NAME_PART.test(parts[0])
    && GITHUB_NAME_PART.test(parts[1]);
}

/**
 * Validate the explicit repository source used by component upgrades.
 *
 * @param {{repo: unknown, branch: unknown, target?: unknown, upgradeSelf?: boolean, upgradeAll?: boolean}} options
 * @returns {{repo: string, branch: string}}
 * @throws {Error} when the source is not an immutable component source
 */
export function validateComponentRepoOverride({
  repo,
  branch,
  target,
  upgradeSelf = false,
  upgradeAll = false,
} = {}) {
  if (upgradeSelf || upgradeAll) {
    throw new Error('--repo is only supported for a component target; --self/--all cannot use an override');
  }

  if (typeof target !== 'string' || target.length === 0 || target.startsWith('-')) {
    throw new Error('--repo is only supported for a component target');
  }

  if (!isValidGitHubRepository(repo)) {
    throw new Error('GitHub repository must be an owner/name slug (URL, empty, and injected values are not allowed)');
  }

  if (typeof branch !== 'string' || !FULL_COMMIT_SHA.test(branch)) {
    throw new Error('--repo requires --branch <40-hex-commit-sha>');
  }

  return { repo, branch };
}
