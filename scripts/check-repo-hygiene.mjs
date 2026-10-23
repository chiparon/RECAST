/**
 * 仓库卫生门禁。
 *
 * 起因：一次 `git add -A` 把 97 个文件提交进主干候选分支 —— 其中 96 个是
 * `… - 副本` 整棵复制目录、一个 15 MB 的 zip、一个 3.6 MB 的 PDF、一张临时截图
 * 和 4 个 .NET 构建产物，只有一个文件是真实改动。这类提交不会被任何测试发现，
 * 只会让仓库体积和 review 成本长期增长。
 *
 *   npm run check:hygiene            # 本地或 CI 直接跑
 *   npm run check:hygiene -- --list  # 只报告，不因体积超限失败
 *
 * 只检查 git 已跟踪的文件；未跟踪文件由 .gitignore 负责。
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const maxBytes = 1_000_000;
/** 分支创建之前就已在仓库里的大文件，保持原样；新增大文件必须显式加入本表。 */
const allowLarge = new Set([
  'docs/proj47-面向 Agent记忆的向量检索系统IO优化-山东大学.pptx',
  'docs/request/聚焦国家战略需求.pdf',
  // Enterprise handoff manual with annotated, sanitized UI screenshots;
  // the Markdown source and individual images are versioned beside it.
  'docs/user-guide/RECAST企业使用说明书.docx',
  // Frozen 716-module oracle used to reproduce the 50-case retrieval dataset;
  // build_dataset.py and experiment.mts read it directly. It is fixture input,
  // not a generated run log or a model/runtime cache.
  'experiments/cross-language-module-retrieval-50/oracle/catalog-snapshot.json',
]);
/** 同样是历史遗留的误提交文件：门禁放过，但仓库里不应再出现新的同类。 */
const legacyTracked = new Set([
  'image.png',
  'docs/image.png',
]);
const forbidden = [
  { pattern: /(^|\/)[^/]*\s-\s副本(\/|$)/, reason: '整棵复制目录（应删除，或放到仓库外）' },
  { pattern: /\.zip$/, reason: '归档压缩包（放 release 或外部存储）' },
  { pattern: /(^|\/)image\.png$/, reason: '临时截图' },
  { pattern: /(^|\/)node_modules\//, reason: '依赖目录' },
];

const reportOnly = process.argv.includes('--list');
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean);

const violations = [];
const legacy = [];
for (const path of tracked) {
  for (const rule of forbidden) {
    if (!rule.pattern.test(path)) continue;
    (legacyTracked.has(path) ? legacy : violations).push({ path, problem: rule.reason });
  }
  if (allowLarge.has(path)) continue;
  let size = 0;
  try { size = statSync(path).size; } catch { continue; }
  if (size > maxBytes) violations.push({ path, problem: `${(size / 1024 / 1024).toFixed(1)} MB，超过 1 MB 上限` });
}

console.log(`仓库卫生检查：${tracked.length} 个已跟踪文件，${violations.length} 处问题`
  + (legacy.length ? `，另有 ${legacy.length} 处历史遗留` : ''));
for (const violation of violations) console.log(`  ✗ ${violation.path}\n      ${violation.problem}`);
for (const item of legacy) console.log(`  · ${item.path}\n      历史遗留（${item.problem}），建议后续清理`);
if (violations.length === 0) console.log('  ✓ 未发现新增的复制目录、归档、临时截图或超限大文件');

const blocking = reportOnly ? [] : violations;
if (blocking.length > 0) {
  console.error(`\n发现 ${blocking.length} 处不该提交的内容；若确需保留，请更新 scripts/check-repo-hygiene.mjs 的白名单并说明原因。`);
  process.exit(1);
}
