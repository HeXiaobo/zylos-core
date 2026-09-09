#!/usr/bin/env node
// CI gate for release-derived images. Main/development images never get latest.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { githubRequest, CATALOG_REPOSITORY, readPublishedDistribution, resolveQualifiedRelease } from './release-channel.mjs';
export function verifyDockerRelease(release, { request = githubRequest } = {}) {
  const { document } = readPublishedDistribution(release, { request });
  const file = JSON.parse(request(`/repos/${CATALOG_REPOSITORY}/contents/Dockerfile?ref=${document.bundle.core.sha}`));
  if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('Cannot verify the release Dockerfile');
  const dockerfile = Buffer.from(file.content, 'base64').toString('utf8');
  const nodeMajor = Number(/^FROM node:(\d+)(?:[-.@:]|\s)/m.exec(dockerfile)?.[1]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) throw new Error('Docker Node base is not supported by the qualification gate');
  const platforms = [...new Set(document.qualifications.filter(q => q.environment.platform === 'linux' && q.environment.nodeMajor === nodeMajor)
    .map(q => q.environment.arch === 'x64' ? 'linux/amd64' : 'linux/arm64'))];
  if (!platforms.length) throw new Error('No matching Linux/Node environment was qualified for this image');
  return { sha: document.bundle.core.sha, version: document.bundle.core.version,
    stable: String(document.channel === 'stable' && resolveQualifiedRelease({ request }).document.bundle.core.version === document.bundle.core.version), platforms: platforms.join(',') };
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const id = process.argv[2];
    if (!/^[1-9]\d*$/.test(id || '')) throw new Error('A GitHub release ID is required');
    const release = JSON.parse(githubRequest(`/repos/${CATALOG_REPOSITORY}/releases/${id}`));
    const output = verifyDockerRelease(release);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(JSON.stringify(output));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
