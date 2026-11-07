import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Architecture also contains dated research reports; check the maintained guides.
const pages = [
  'README.md', 'CONTRIBUTING.md', '.github/pull_request_template.md', 'docs/README.md',
  'docs/architecture/system-overview.md', 'docs/architecture/api.md',
  ...globSync('docs/{requirements,decisions,testing,engineering,maintenance}/**/*.md', { cwd: root }),
];

function linkDestinations(line) {
  const destinations = [];
  const definition = line.match(/^ {0,3}\[[^\]]+\]:\s*(.*)$/);
  if (definition) destinations.push(definition[1]);
  for (const match of line.matchAll(/\]\(\s*/g)) {
    const start = match.index + match[0].length;
    if (line[start] === '<') {
      const end = line.indexOf('>', start + 1);
      if (end >= 0) destinations.push(line.slice(start, end + 1));
      continue;
    }
    // A bare destination can contain balanced (or backslash-escaped) parentheses.
    let depth = 1;
    for (let i = start; i < line.length; i++) {
      switch (line[i]) {
        case '\\':
          i++;
          break;
        case '(':
          depth++;
          break;
        case ')':
          depth--;
          break;
      }
      if (depth === 0) {
        destinations.push(line.slice(start, i).trim());
        break;
      }
    }
  }
  return destinations;
}

function localPath(destination) {
  const raw = destination.startsWith('<')
    ? destination.slice(1, destination.indexOf('>'))
    : destination.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '');
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) return '';
  return decodeURIComponent(raw.split(/[?#]/, 1)[0]).replace(/\\([()\\])/g, '$1');
}

let links = 0;
let failures = 0;
for (const page of pages) {
  const absolute = path.join(root, page);
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
  let fence;
  for (const [index, line] of lines.entries()) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    for (const destination of linkDestinations(line.replace(/(`+)(.+?)\1/g, ''))) {
      try {
        const relative = localPath(destination);
        if (!relative) continue;
        links++;
        const target = relative.startsWith('/')
          ? path.join(root, relative)
          : path.resolve(path.dirname(absolute), relative);
        const contained = path.relative(root, target);
        if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained) || !existsSync(target)) {
          throw new Error('Target missing or outside the repository');
        }
      } catch (error) {
        failures++;
        console.error(`${page}:${index + 1}: ${destination} (${error.message})`);
      }
    }
  }
}
console.log(`Documentation: ${pages.length} pages, ${links} local links, ${failures} errors.`);
if (failures) process.exitCode = 1;
