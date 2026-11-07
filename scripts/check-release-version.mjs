import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('apps/vscode-extension/package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const locked = lock.packages['apps/vscode-extension'];
if (manifest.name !== locked?.name || manifest.version !== locked?.version) {
  throw new Error('Extension name/version differs from package-lock.json. Refresh the lock before packaging.');
}
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
if (tag && tag !== `v${manifest.version}`) {
  throw new Error(`Release tag ${tag} does not match the extension version v${manifest.version}.`);
}
console.log(`Verified ${manifest.name} v${manifest.version}${tag ? ` for ${tag}` : ''}.`);
