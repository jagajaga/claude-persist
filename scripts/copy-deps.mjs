// Copy npm packages, and everything they depend on at runtime, from the
// workspace's node_modules into the extension's daemon/node_modules.
//
//   node scripts/copy-deps.mjs <dest node_modules> <package> [<package>...]
//
// The vsix ships only what package.sh puts in it. A dependency copied by
// hand (as `ws` is) is fine for a package with none of its own; Shiki brings
// forty-odd, and missing one fails only on the server, at first use.
import fs from 'node:fs';
import path from 'node:path';

const [dest, ...roots] = process.argv.slice(2);
if (!dest || roots.length === 0) {
  console.error('usage: copy-deps.mjs <dest node_modules> <package>...');
  process.exit(2);
}
const seen = new Set();
const walk = (name) => {
  if (seen.has(name)) return;
  const dir = path.join('node_modules', name);
  if (!fs.existsSync(path.join(dir, 'package.json'))) throw new Error(`not installed: ${name}`);
  seen.add(name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep);
};
roots.forEach(walk);
for (const name of seen) {
  fs.mkdirSync(path.dirname(path.join(dest, name)), { recursive: true });
  fs.cpSync(path.join('node_modules', name), path.join(dest, name), { recursive: true, dereference: true });
}
console.log(`copied ${seen.size} packages for ${roots.join(', ')}`);
