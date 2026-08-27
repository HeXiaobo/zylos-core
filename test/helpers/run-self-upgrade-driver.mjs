/**
 * Isolated #717 self-upgrade seam.
 *
 * This drives the real old-launcher runSelfUpgrade() orchestration, the real
 * finalizer state serialization/restore APIs, real step 5 smart merge, and
 * the old launcher's printStep callback. The installed-finalizer boundary is
 * injected, as are npm and PM2 effects, so the host installation is never
 * touched.
 *
 * argv: <package-temp-dir> <success|json|later-failure|no-conflict>
 * stdout: one JSON object containing the result and captured launcher output
 */
import fs from 'node:fs';
import path from 'node:path';

const [tempDir, scenario] = process.argv.slice(2);
const zylosDir = process.env.ZYLOS_DIR;
if (!tempDir || !scenario || !zylosDir) {
  throw new Error('Usage: run-self-upgrade-driver.mjs <tempDir> <scenario> with ZYLOS_DIR');
}

const {
  cleanupBackup,
  createFinalizeState,
  runSelfUpgrade,
  runSelfUpgradeFinalize,
  rollbackSelf,
  step5_syncCoreSkills,
} = await import('../../cli/lib/self-upgrade.js');
const { printStep } = await import('../../cli/commands/component.js');

const transactionBackupDir = path.join(zylosDir, 'transaction-backup');
const globalCoreDir = path.join(zylosDir, 'global', 'node_modules', 'zylos');
const npmCommands = [];
const stoppedServices = [];
const restartedServices = [];
const launcherOutput = [];
const originalLog = console.log;
console.log = (...args) => launcherOutput.push(args.join(' '));
fs.mkdirSync(globalCoreDir, { recursive: true });
fs.writeFileSync(path.join(globalCoreDir, 'package.json'), JSON.stringify({
  name: 'zylos',
  version: '0.5.3',
}));

let result;
try {
  result = runSelfUpgrade({
    tempDir,
    newVersion: '0.5.4-test',
    mode: 'merge',
    onStep: scenario === 'json' ? undefined : printStep,
  }, {
    getCurrentVersion: () => ({ success: true, version: '0.5.3' }),
    step1: {
      zylosDir,
      skillsDir: path.join(zylosDir, '.claude', 'skills'),
      backupDir: transactionBackupDir,
      corePackageDir: globalCoreDir,
      // The fixture package is the installed Core target for the synthetic
      // merge.  Supplying its skill root gives the continuity gate explicit
      // ownership provenance instead of relying on a same-name heuristic.
      installedCoreSkillsDir: path.join(tempDir, 'skills'),
    },
    step3: {
      getSkillsServices: () => [{ name: 'fixture-service', status: 'online' }],
      stopService: (name) => stoppedServices.push(name),
    },
    step4: {
      execSync: (command) => {
        npmCommands.push(command);
        if (command.startsWith('npm install -g')) {
          fs.writeFileSync(path.join(globalCoreDir, 'package.json'), JSON.stringify({
            name: 'zylos',
            version: '0.5.4-test',
          }));
        }
        return command.startsWith('npm pack') ? 'zylos-fixture.tgz\n' : '';
      },
    },
    runInstalledFinalizer: (ctx) => {
      const steps = [
        (finalizerCtx) => step5_syncCoreSkills(finalizerCtx, { zylosDir }),
      ];
      if (scenario === 'later-failure') {
        steps.push(() => ({
          step: 6,
          name: 'install_skill_dependencies',
          status: 'failed',
          error: 'injected later failure',
        }));
      }
      return runSelfUpgradeFinalize(createFinalizeState(ctx), {
        steps,
        rollbackSelf: (finalizerCtx) => rollbackSelf(finalizerCtx, {
          zylosDir,
          skillsDir: path.join(zylosDir, '.claude', 'skills'),
          restartManagedProcess: (name) => restartedServices.push(name),
        }),
      });
    },
  });

  // Match component.js ownership: only the non-JSON successful launcher
  // removes the temporary transaction backup.
  if (scenario !== 'json' && result.success && result.backupDir) {
    cleanupBackup(result.backupDir);
  }
} finally {
  console.log = originalLog;
}

originalLog(JSON.stringify({
  result,
  launcherOutput,
  npmCommands,
  stoppedServices,
  restartedServices,
  transactionBackupDir,
  globalCoreVersion: JSON.parse(fs.readFileSync(path.join(globalCoreDir, 'package.json'), 'utf8')).version,
}));
