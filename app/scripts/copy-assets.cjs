// Copy non-TypeScript runtime assets (EJS views, css, js) into dist/ after tsc.
// Cross-platform (no shell globbing needed).
const fs = require('fs');
const path = require('path');

const pairs = [
  ['src/views', 'dist/views'],
  ['src/public', 'dist/public'],
];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

for (const [src, dest] of pairs) {
  if (fs.existsSync(src)) {
    copyDir(src, dest);
    console.log(`copied ${src} -> ${dest}`);
  }
}
