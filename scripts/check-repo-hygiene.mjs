/** Keep the release tree free of experiment corpora and generated artifacts. */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const allowedLarge = new Set(['docs/user-guide/RECAST企业使用说明书.docx']);
const forbidden = [
  { pattern: /^(experiments|logs|research)\//, reason: '实验与历史材料应保存在归档分支' },
  { pattern: /(^|\/)(node_modules|bin|obj|dist|target|coverage|__pycache__|\.pytest_cache|\.translation-verifier-scripts|\.translation-verifier-reports)\//, reason: '依赖、构建产物或运行缓存' },
  { pattern: /\.(?:dll|exe|pdb|pyc|class|tsbuildinfo|gcda|gcno|log|zip|pptx)$/i, reason: '生成产物或归档材料' },
  { pattern: /(^|\/)[^/]*\s-\s副本(\/|$)/, reason: '复制目录' },
];
export function releaseTreeProblems(files) {
  const problems = []; let bytes = 0;
  for (const file of files) {
    bytes += file.bytes;
    for (const rule of forbidden) if (rule.pattern.test(file.path)) problems.push({ path: file.path, problem: rule.reason });
    if (file.bytes > 1_000_000 && !allowedLarge.has(file.path)) problems.push({ path: file.path, problem: '单文件超过 1 MB' });
  }
  if (files.length > 5_000) problems.push({ path: '(tree)', problem: `发布树有 ${files.length} 个文件，超过 5000 个文件预算` });
  if (bytes > 50_000_000) problems.push({ path: '(tree)', problem: `发布树内容超过 50 MB：${(bytes / 1e6).toFixed(2)} MB` });
  return problems;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const files = tracked.map(path => { try { return { path, bytes: statSync(path).size }; } catch { return { path, bytes: 0 }; } });
  const problems = releaseTreeProblems(files);
  console.log(`发布树检查：${files.length} 个文件，${(files.reduce((sum, file) => sum + file.bytes, 0) / 1e6).toFixed(2)} MB，${problems.length} 处问题`);
  for (const item of problems) console.log(`  ${item.path}: ${item.problem}`);
  if (problems.length && !process.argv.includes('--list')) process.exitCode = 1;
}
