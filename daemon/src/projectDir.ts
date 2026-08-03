/**
 * Claude Code's directory name for a project's transcripts: every
 * non-alphanumeric character of the cwd becomes a literal '-' (verified against
 * real ~/.claude/projects entries, e.g. ".../blooper2.0/.claude-worktrees/x"
 * -> "...-blooper2-0--claude-worktrees-x" — no collapsing of runs).
 *
 * Its own module purely to break an import cycle: importer.ts needs to know
 * which account is active to pick a projects dir, and accounts.ts needs this
 * encoding to relocate a transcript between config dirs. With the function
 * living in importer.ts those two files imported each other.
 *
 * Note the caller's responsibility: Claude Code realpaths cwd before encoding
 * it, so anything comparing against on-disk names must resolve symlinks first
 * (see projectDirCandidates in accounts.ts).
 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
