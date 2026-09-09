import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDockerRelease } from '../../../tools/upgrade/verify-published.mjs';
import { bundle, distribution, catalog, environment } from './helpers/qualified-release-fixture.js';
function fixture(versions = ['1.0.0'], nodeMajor = 22) {
 const data = catalog(versions.map((version, index) => distribution({ target: bundle(version), releaseTag: `bundle-${index}`, env: { ...environment, platform: 'linux', nodeMajor } })));
 data.paths[`/repos/HeXiaobo/zylos-core/contents/Dockerfile?ref=${bundle().core.sha}`] = JSON.stringify({ encoding: 'base64', content: Buffer.from('FROM node:22-slim\n').toString('base64') });
 return data;
}
test('Docker publishes only matching Linux/Node platforms and latest never selects an older version or preview', () => {
 const data = fixture(['1.0.0', '2.0.0', '3.0.0-rc.1']);
 assert.equal(verifyDockerRelease(data.releases[0], data).stable, 'false');
 assert.equal(verifyDockerRelease(data.releases[1], data).stable, 'true');
 assert.equal(verifyDockerRelease(data.releases[2], data).stable, 'false');
 const mismatch = fixture(['1.0.0'], 24);
 assert.throws(() => verifyDockerRelease(mismatch.releases[0], mismatch), /No matching/);
});
