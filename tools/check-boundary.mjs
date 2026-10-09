// Fails if frontend/ and backend/ reach into each other. They may only talk over HTTP/WebSocket.
// Run from the repo root:  node tools/check-boundary.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const parts = ['frontend', 'BACKEND'];
const skip = new Set(['node_modules', 'dist', 'android', '.git']);
const exts = /\.(js|mjs|cjs|ts|tsx|jsx|json)$/;
const importRe = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

let problems = 0;
function walk(dir, part) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, part);
    else if (exts.test(entry.name) && !/package(-lock)?\.json$/.test(entry.name)) {
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(importRe)) {
        const spec = m[1] || m[2] || m[3];
        if (!spec || !spec.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(full), spec);
        if (!resolved.startsWith(path.join(root, part) + path.sep)) {
          problems++;
          console.error(`✗ ${path.relative(root, full)} imports "${spec}" which is outside ${part}/`);
        }
      }
    }
  }
}
for (const part of parts) walk(path.join(root, part), part);

if (problems) {
  console.error(`\n${problems} boundary violation(s).`);
  process.exit(1);
}
console.log('✓ frontend/ and BACKEND/ are fully separate: no cross-folder imports.');
