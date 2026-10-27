// Source files for the phone, coloured exactly as VS Code colours them.
//
// Shiki runs VS Code's own TextMate grammars and themes, so a file on the
// phone looks the way it looks in the editor, for 200+ languages. It runs
// here and sends coloured spans; the phone draws them natively -- no grammar
// bundle in the app, and new languages arrive with a daemon update alone.
// Loaded on first use: most daemons never highlight anything.
import fs from 'node:fs';
import path from 'node:path';

/** The editor's default light theme; the app is light. */
export const THEME = 'light-plus';
/** Beyond this, only the start of a file is coloured; the phone pages the rest as plain text. */
export const MAX_HIGHLIGHT_BYTES = 1024 * 1024;

/** [text, colour "#rrggbb" or null for the default, style: 1 italic, 2 bold, 4 underline]. */
export type Span = [string, string | null, number];

export interface Highlighted {
  language: string;
  theme: string;
  /** Default foreground and background of the theme. */
  fg: string;
  bg: string;
  lines: Span[][];
  /** The file was longer than MAX_HIGHLIGHT_BYTES; `lines` covers its start. */
  truncated: boolean;
  size: number;
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'docker', makefile: 'make', gnumakefile: 'make', cmakelists: 'cmake',
  '.gitignore': 'ignore', '.dockerignore': 'ignore', '.npmignore': 'ignore', '.env': 'dotenv',
  '.bashrc': 'shellscript', '.zshrc': 'shellscript', '.profile': 'shellscript', caddyfile: 'caddy',
  jenkinsfile: 'groovy', gemfile: 'ruby', rakefile: 'ruby', podfile: 'ruby', vagrantfile: 'ruby',
};
const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', json: 'json',
  kt: 'kotlin', kts: 'kotlin', mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript',
  yml: 'yaml', h: 'c', hpp: 'cpp', cc: 'cpp', hh: 'cpp', cs: 'csharp', rs: 'rust', py: 'python', rb: 'ruby',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', md: 'markdown', htm: 'html', txt: 'text',
  log: 'log', conf: 'ini', cfg: 'ini', gradle: 'groovy', tf: 'terraform', ex: 'elixir', exs: 'elixir',
  jsonl: 'json', lock: 'json', svg: 'xml', plist: 'xml', patch: 'diff',
};

/** The Shiki language for a file, from its name; 'text' when nothing fits. */
export function languageFor(file: string, known: (lang: string) => boolean): string {
  const base = path.basename(file).toLowerCase();
  const byName = BY_NAME[base] ?? BY_NAME[base.replace(/\..*$/, '')];
  if (byName && known(byName)) return byName;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  if (!ext) return 'text';
  const mapped = BY_EXT[ext] ?? ext;
  return known(mapped) ? mapped : 'text';
}

type Shiki = typeof import('shiki');
let shiki: Promise<Shiki> | null = null;

export async function highlightFile(file: string): Promise<Highlighted> {
  if (!path.isAbsolute(file)) throw new Error('The path must be absolute');
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Not a file');
  const truncated = stat.size > MAX_HIGHLIGHT_BYTES;
  const fd = fs.openSync(file, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_HIGHLIGHT_BYTES));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    text = buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  // A cut can land mid-line: keep only whole lines.
  if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));

  shiki ??= import('shiki');
  const s = await shiki;
  const known = (lang: string): boolean => lang === 'text' || lang in s.bundledLanguages;
  const language = languageFor(file, known);
  const result = await s.codeToTokens(text, { lang: language as never, theme: THEME as never });
  const fg = result.fg ?? '#000000';
  const lines: Span[][] = result.tokens.map((line) => {
    const spans: Span[] = [];
    for (const token of line) {
      const colour = token.color && token.color.toLowerCase() !== fg.toLowerCase() ? token.color.slice(0, 7) : null;
      const style = token.fontStyle && token.fontStyle > 0 ? token.fontStyle : 0;
      const last = spans[spans.length - 1];
      // Neighbours alike are one span: a third of the payload, on real code.
      if (last && last[1] === colour && last[2] === style) last[0] += token.content;
      else spans.push([token.content, colour, style]);
    }
    return spans;
  });
  return { language, theme: THEME, fg, bg: result.bg ?? '#ffffff', lines, truncated, size: stat.size };
}
