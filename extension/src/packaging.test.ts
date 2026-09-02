import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The packaged VSIX ships `dist/`, `media/` and a bundled `daemon/` — and no
 * node_modules beside dist. So any runtime require() of a bare package
 * specifier from the extension host resolves in this monorepo (via the
 * workspace symlink) and then fails at load time on a user's machine, taking
 * activate() with it: no sidebar, no chat tabs, and no working update
 * mechanism to recover with.
 *
 * `import type` is erased and stays fine; this catches the value imports.
 *
 * One narrow, named exception: chatWebview.test.js spins up a jsdom window to
 * exercise the webview client (extension/media/chat.js) and requires the
 * jsdom package to do it. That require() is real, but it is not a runtime
 * hazard the way an activation-path require would be — nothing under
 * extension.ts ever requires a *.test.js file, compiled or not, so it never
 * executes during activation. It IS worth naming explicitly rather than
 * exempting every "*.test.js" wholesale. .vscodeignore now excludes
 * dist/**\/*.test.js and scripts/package.sh strips the bundled daemon's
 * compiled tests (its node_modules/** rule matches only the extension root,
 * which is the same reason the bundled runtime survives packaging), so they no
 * longer ship — but a blanket "*.test.js" exemption would still silently wave
 * through a bare require in *any* future test file, vetted or not. Naming the
 * one file (and the one specifier) keeps the guard meaningful.
 */
test('no compiled extension-host file requires a bare package at runtime', () => {
  const dist = path.join(__dirname); // this test runs from dist/
  const ALLOWLIST: Record<string, string[]> = {
    'chatWebview.test.js': ['jsdom'],
  };
  const offenders: string[] = [];
  // Recursive: a future src/<subdir>/foo.ts lands in dist/<subdir>/ and must
  // not slip past this check.
  for (const file of fs.readdirSync(dist, { recursive: true }) as string[]) {
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(dist, file), 'utf8');
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const specifier = match[1];
      // Relative paths ship with us; 'vscode' is injected by the host; Node
      // built-ins are always present.
      if (specifier.startsWith('.') || specifier === 'vscode') continue;
      if (specifier.startsWith('node:')) continue;
      if (ALLOWLIST[file]?.includes(specifier)) continue;
      try {
        // Core modules resolve to their own bare name; anything else resolves
        // to a path, which means it came from node_modules — and node_modules
        // is exactly what the VSIX does not ship.
        if (require.resolve(specifier) === specifier) continue;
      } catch {
        // Not resolvable at all: still a runtime failure waiting to happen.
      }
      offenders.push(`${file} -> ${specifier}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Runtime require() of a bare specifier will break activation in the VSIX:\n${offenders.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// Manifest guarantees a new user depends on
// ---------------------------------------------------------------------------

const manifestFull = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
) as { publisher: string; name: string };

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
) as {
  keywords?: string[];
  capabilities?: { untrustedWorkspaces?: { supported?: boolean; description?: string } };
  contributes?: {
    commands?: Array<{ command: string; title: string; category?: string }>;
    walkthroughs?: Array<{ id: string; steps?: Array<{ media?: { markdown?: string } }> }>;
  };
};

/**
 * With no `capabilities.untrustedWorkspaces` declaration, VS Code defaults an
 * extension to *not supported* in Restricted Mode and disables it silently.
 * A freshly cloned folder is untrusted by default, so that is exactly where a
 * new user starts: the activity-bar icon never appears and nothing explains it.
 * Declaring it — even as unsupported — is what makes VS Code show the reason.
 */
test('workspace trust is declared, with a reason', () => {
  const trust = manifest.capabilities?.untrustedWorkspaces;
  assert.ok(trust, 'capabilities.untrustedWorkspaces missing: the extension vanishes in Restricted Mode');
  assert.equal(typeof trust.supported, 'boolean');
  assert.ok(
    (trust.description ?? '').length > 20,
    'an undeclared reason leaves the user with a disabled extension and no explanation',
  );
});

/**
 * Sign-in used to be reachable only from a menu inside the model pill, inside a
 * chat panel, which itself only exists once you have created a session. A user
 * with no Claude credentials had no way to find it.
 */
test('signing in is reachable from the Command Palette', () => {
  const commands = manifest.contributes?.commands ?? [];
  const addAccount = commands.find((c) => c.command === 'claudePersist.addAccount');
  assert.ok(addAccount, 'no claudePersist.addAccount command: sign-in is unreachable from a cold start');
  assert.equal(addAccount.category, 'Claude Persist', 'palette grouping relies on the category');
});

test('the listing carries keywords, or marketplace search cannot find it', () => {
  assert.ok((manifest.keywords ?? []).length >= 3);
  assert.ok(manifest.keywords?.includes('claude'));
});

/**
 * Every palette-visible command needs the category, or it appears in the
 * palette as a bare verb with nothing tying it to this extension. Two commands
 * exist only for the tree's context menu and are hidden from the palette, so
 * they are exempt.
 */
test('palette commands are grouped under one category', () => {
  const hidden = new Set(['claudePersist.openSessionFromTree', 'claudePersist.deleteSessionItem']);
  for (const command of manifest.contributes?.commands ?? []) {
    if (hidden.has(command.command)) continue;
    assert.equal(command.category, 'Claude Persist', `${command.command} has no category`);
    assert.ok(
      !command.title.startsWith('Claude Persist'),
      `${command.command} repeats the category in its title, so the palette shows it twice`,
    );
  }
});

/**
 * VS Code's post-install "Get Started" page showed nothing for this extension,
 * which is the one moment a new user is looking for instructions.
 */
test('the walkthrough exists and its media files are really there', () => {
  const walkthroughs = manifest.contributes?.walkthroughs ?? [];
  assert.ok(walkthroughs.length >= 1, 'no walkthrough: the Get Started page is empty');
  for (const step of walkthroughs[0].steps ?? []) {
    const markdown = step.media?.markdown;
    if (!markdown) continue;
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', markdown)),
      `walkthrough media missing: ${markdown} — the step renders blank`,
    );
  }
});

/**
 * The repo README quotes the suite size as a sign of life. A number that
 * drifts is worse than no number, and nothing else would ever catch it.
 */
test('the README test counts are not stale', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  const claim = /(\d+) daemon \+ (\d+) extension tests/.exec(readme);
  assert.ok(claim, 'README no longer states the test counts; drop this test or restore the line');

  const count = (dir: string): number =>
    (fs.readdirSync(dir) as string[])
      .filter((f) => f.endsWith('.test.ts'))
      .reduce((n, f) => n + (fs.readFileSync(path.join(dir, f), 'utf8').match(/^test\(/gm)?.length ?? 0), 0);

  const repo = path.join(__dirname, '..', '..');
  for (const [label, dir, stated] of [
    ['daemon', path.join(repo, 'daemon', 'src'), Number(claim[1])],
    ['extension', path.join(repo, 'extension', 'src'), Number(claim[2])],
  ] as Array<[string, string, number]>) {
    const actual = count(dir);
    // Exact is unmaintainable across a single added test; a drift of more than
    // a tenth means the line has been left behind entirely.
    assert.ok(
      Math.abs(actual - stated) <= Math.max(5, actual * 0.1),
      `README says ${stated} ${label} tests, there are ${actual}`,
    );
  }
});

/**
 * The marketplace does not resolve relative image paths — a `![](media/x.png)`
 * renders as a broken image there while looking perfectly fine in every local
 * preview and on GitHub, so nothing but a check catches it.
 */
test('the listing screenshot ships, and is referenced absolutely', () => {
  const media = path.join(__dirname, '..', 'media');
  const listing = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  const images = [...listing.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(images.length > 0, 'the listing has no screenshot at all');
  for (const src of images) {
    assert.match(src, /^https:\/\//, `${src} is relative; the marketplace will not render it`);
  }

  // The absolute URL points back into this repo, so the file has to be here
  // and has to ship, or the listing shows a broken image after release.
  for (const src of images) {
    const inRepo = /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/extension\/(.+)$/.exec(src);
    if (!inRepo) continue;
    const local = path.join(__dirname, '..', inRepo[1]);
    assert.ok(fs.existsSync(local), `${src} points at ${inRepo[1]}, which is not in the extension`);
    assert.ok(fs.statSync(local).size < 2_000_000, `${inRepo[1]} is too heavy to ship`);
  }
  assert.ok(fs.existsSync(path.join(media, 'screenshot.png')));
});

/**
 * Badges are the one part of a README that silently rots: the publisher or
 * extension name changes, every badge keeps returning a valid image, and it
 * reports someone else's numbers — or none — forever. shields.io has already
 * retired its Visual Studio Marketplace badges once.
 */
test('README badges point at this extension', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  const badges = [...readme.matchAll(/src="(https:\/\/[^"]*(?:shields\.io|vsmarketplacebadges|badgen)[^"]*)"/g)]
    .map((m) => m[1]);
  assert.ok(badges.length >= 3, `only ${badges.length} badges found; expected the row`);

  const id = `${manifestFull.publisher}.${manifestFull.name}`;
  const openVsxId = `${manifestFull.publisher}/${manifestFull.name}`;
  for (const url of badges) {
    if (/marketplace|vs-marketplace/.test(url)) {
      assert.ok(url.includes(id), `${url} does not name ${id}`);
    }
    if (/open-vsx/.test(url)) {
      assert.ok(url.includes(openVsxId), `${url} does not name ${openVsxId}`);
    }
    assert.ok(!url.includes('visual-studio-marketplace/'), `${url} uses the retired shields badge`);
  }
});

/**
 * The size cap belongs on the preview box, not on the picture inside it.
 * Written on the picture as min(320px, 100%), the percentage is indefinite
 * while the box is being sized -- so the box took the full available width and
 * the picture then settled to 320px, leaving up to 60px of box beside it.
 * Invisible on an image; on a video the play badge covers the box, so its scrim
 * hung past the frame as a grey strip. Measured in chromium: the shipped rule
 * gave `wrap 380 media 320`, the cap on the box gives `wrap 320 media 320`, and
 * a tall screenshot and a 280px viewport both stay flush.
 */
test('the preview box is the size of the picture in it', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8');
  const rule = (selector: string): string =>
    new RegExp(`\\n${selector.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  assert.match(
    rule('.img-thumb'),
    /max-width:\s*min\(320px,\s*100%\)/,
    'the box must carry the width cap, or it sizes itself to the available width',
  );
  for (const selector of ['.img-thumb img', '.img-thumb video']) {
    const body = rule(selector);
    assert.ok(body, `no rule found for ${selector}; this test is looking in the wrong place`);
    assert.doesNotMatch(
      body,
      /max-width:\s*min\(/,
      `${selector} must not cap itself with a percentage: the box cannot size to it`,
    );
  }
});

/**
 * The CSP had `default-src 'none'` and named neither img-src nor media-src, so
 * every preview was blocked. It never looked broken: the img error handler
 * quietly swapped in a plain link, so the feature appeared to work and had
 * never once drawn a picture.
 */
test('the webview may load the media it renders', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatPanel.ts'), 'utf8');
  const csp = /Content-Security-Policy[\s\S]*?content="([^"]+)"/.exec(source)?.[1] ?? '';
  assert.ok(csp.length > 0, 'no CSP found; this test is looking in the wrong place');
  for (const directive of ['img-src', 'media-src']) {
    assert.ok(csp.includes(directive), `CSP has no ${directive}: previews are blocked`);
  }
  assert.match(csp, /img-src[^;]*cspSource/, 'img-src must admit the webview resource origin');
  assert.match(csp, /media-src[^;]*cspSource/, 'media-src must admit the webview resource origin');
  // A clip is fetched into a blob before it can play (see playableSrc), and a
  // fetch is governed by connect-src -- which, unnamed, falls back to
  // `default-src 'none'` and blocks every video preview.
  assert.match(csp, /connect-src[^;]*cspSource/, 'connect-src must admit the webview resource origin');
});
