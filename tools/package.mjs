import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const version = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).version;
const sourceStage = join(dist, 'source-stage');
const extensionStage = join(dist, 'extension-stage');
const extensionFiles = ['manifest.json', 'index.js', 'style.css', 'role-control.mjs', 'bridge-client.mjs', 'capability-contract.json', 'README.md', 'NOTICE.md', 'LICENSE'];
const sourceFiles = [...extensionFiles, '.gitignore', '.gitattributes', 'package.json', 'role-control.test.mjs', 'bridge-client.test.mjs', 'integration.test.mjs',
  'android/build.gradle.kts', 'android/settings.gradle.kts', 'android/gradle.properties', 'android/gradlew', 'android/gradlew.bat', 'android/app/build.gradle.kts'];

async function copy(relativePath, stage) {
  const target = join(stage, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, relativePath), target);
}
async function tree(relativePath, stage) {
  for (const entry of await readdir(join(root, relativePath), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Packaging does not follow symlinks');
    const path = relativePath + '/' + entry.name;
    if (entry.isDirectory()) await tree(path, stage);
    else await copy(path, stage);
  }
}
await mkdir(dist, { recursive: true });
for (const stage of [sourceStage, extensionStage]) {
  if (dirname(stage) !== dist) throw new Error('Refusing to clean a path outside distribution staging');
  await rm(stage, { recursive: true, force: true });
}
for (const file of extensionFiles) await copy(file, extensionStage);
for (const file of sourceFiles) await copy(file, sourceStage);
for (const directory of ['android/app/src', 'android/gradle', 'docs', 'tools']) await tree(directory, sourceStage);

// Audit the actual distribution staging tree, never the developer's build/cache directories.
let inspected = 0;
async function audit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await audit(path);
    else {
      const publicPath = relative(sourceStage, path).replaceAll('\\', '/');
      if (/local\.properties|\.jks$|\.keystore$|auth\.json|secrets\.json/i.test(publicPath)) throw new Error('Private file in distribution: ' + publicPath);
      if (!/\.(?:jar|png)$/i.test(path)) {
        const text = await readFile(path, 'utf8');
        if (/[A-Z]:[\\/](?:Users|workspace|gptworkspace|CodexData|jiyi)\b/i.test(text)) throw new Error('Local absolute path in distribution: ' + publicPath);
        if (/gh[pousr]_[A-Za-z0-9]{25,}|sk-[A-Za-z0-9]{25,}/.test(text)) throw new Error('Credential-like value in distribution: ' + publicPath);
      }
      inspected++;
    }
  }
}
await audit(sourceStage);
await audit(extensionStage);
const apkName = `yuzuki-device-bridge-${version}.apk`;
await copyFile(join(root, 'android/app/build/outputs/apk/debug/app-debug.apk'), join(dist, apkName));
const apk = await readFile(join(dist, apkName));
await writeFile(join(dist, 'package-audit.json'), JSON.stringify({ version, inspectedFiles: inspected,
  containsLocalConfiguration: false, containsRawDeviceLogs: false, apkSha256: createHash('sha256').update(apk).digest('hex'),
  hardwareVerified: false, repository: 'https://github.com/yanyu612/yuzuki-device-bridge' }, null, 2) + '\n');
console.log(JSON.stringify({ version, inspectedFiles: inspected, apk: apkName, sourceStage, extensionStage }));
