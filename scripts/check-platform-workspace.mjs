#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkPlatformWorkspace(root, { dependencies = true } = {}) {
  const configFile = path.join(root, '.recast-platforms.json');
  if (existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    const expected = process.platform === 'win32' ? config.windowsRoot : config.wslRoot;
    const actual = realpathSync(root);
    const equal = process.platform === 'win32'
      ? actual.toLowerCase() === realpathSync(expected).toLowerCase()
      : actual === realpathSync(expected);
    if (!equal) throw new Error(`当前是 ${process.platform}，请在 ${expected} 执行命令。两个平台的 node_modules 和 dist 必须隔离。`);
  }
  if (dependencies) {
    const binary = path.join(root, 'node_modules', '@esbuild', `${process.platform}-${process.arch}`, 'package.json');
    const vite = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
    if (!existsSync(binary) || !existsSync(vite)) {
      throw new Error(`当前目录缺少 ${process.platform}-${process.arch} 依赖，请在本平台的工作目录执行 npm ci。`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const beforeInstall = process.argv[2] === '--before-install';
    checkPlatformWorkspace(root, { dependencies: !beforeInstall });
    console.log(`Platform workspace ${beforeInstall ? 'selected for install' : 'ready'}: ${process.platform}-${process.arch} · ${root}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
