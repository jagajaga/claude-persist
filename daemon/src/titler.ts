// Naming a session after what it turned out to be about.
//
// A tab is named when it is created, which is the one moment nobody knows what
// the work is yet: you get "blooper2.0-" and whatever you typed after it. The
// conversation itself is the only thing that knows, and it knows more as it
// goes -- so the name is asked for again as the work drifts.
//
// It runs on the session's own account through the Agent SDK, not the HTTP API:
// same OAuth login, no key to hold, nothing billed separately. `tools: []` is
// what makes that affordable. Measured on a real exchange: with the built-in
// tools left in, a title costs 18,175 tokens of cache-write, because Claude
// Code ships its entire tool surface to a model that was never going to call
// one. With them off, the same call is ~730 tokens -- a fortieth of an ordinary
// turn.
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

/** Cheapest model that can read an exchange and name it. */
export const TITLE_MODEL = 'claude-haiku-4-5';

/**
 * How long a session goes before its name is looked at again.
 *
 * Time, not turns: a turn is anything from a one-word answer to an hour of
 * work, so counting them measures nothing you can feel. Twenty minutes of
 * actually working in a tab is the point at which the subject may have moved.
 *
 * Only ever checked when a turn completes, so a tab nobody is touching is never
 * re-named and never costs anything -- "twenty minutes" means twenty minutes of
 * activity, not of wall clock.
 *
 * Looking again is not renaming. Most of the time the work is a continuation
 * and the name still fits, which isMaterialChange decides; the rename happens
 * only when the subject has genuinely become something else.
 */
export const RETITLE_AFTER_MS = 20 * 60_000;

/**
 * The name half of a title: `blo|Post-merge CI`.
 *
 * A tab strip is narrow and shows several at once, so the budget is spent on
 * the part that differs. Twenty characters is about what stays readable before
 * the tab elides it.
 */
export const MAX_NAME_CHARS = 20;
/** Past this the model answered with prose instead of a title. */
const MAX_TITLE_WORDS = 12;
/**
 * How an answer that is not a title begins.
 *
 * Length alone does not catch these: "I cannot name this for you today" is
 * seven words and would have gone straight onto a tab. A name for a piece of
 * work does not open in the first person or with an acknowledgement.
 */
const NOT_A_TITLE = /^(?:i|i'm|im|sure|certainly|of course|okay|ok|sorry|here|hi|hello|apologies)\b/i;
/** Per message, so a long turn cannot dominate the prompt. */
const MAX_EXCHANGE_CHARS = 300;

/**
 * What a person types to steer rather than to say what the work is.
 *
 * These dominated every window position I tried. Ten real sessions opened with
 * "Status", "restart and continue", "3 then 1", "So what should we do?" and
 * "What you need from me" -- and the names that came out were named after
 * whatever the assistant happened to be doing when asked: "Main merge",
 * "Backend mypy gate". A session's identity is not at either end of its log.
 */
const CONTROL_UTTERANCE =
  /^(?:status|go|ok(?:ay)?|yes+|no|next|do it|proceed|continue|restart and continue|thanks?|ty|nice|good|great|cool|stop|wait|why|how|what\??|hm+|\d[\s\d,]*(?:then\s*\d+)?|so what should we do\??|what (?:do )?you need.*|and\??|more|again|fix it|try again)[.!?]*$/i;

/** Shorter than this, a message is a nudge rather than a statement of work. */
const MIN_SUBSTANCE_CHARS = 16;

export interface Exchange {
  role: 'user' | 'assistant';
  text: string;
}

export interface TitleState {
  /** Completed turns so far. The first naming waits for one. */
  turns: number;
  /** When the name was last asked for, or undefined if never. */
  titledAt?: number;
  /** Now, injected so the rule can be tested without waiting twenty minutes. */
  now?: number;
  /** A name you chose yourself is never replaced by one of these. */
  titleSetByUser?: boolean;
  /**
   * A turn is parked on a rate limit or an overload.
   *
   * Nothing is named then. The account is waiting for room, and spending what
   * room there is on a tab name -- or queueing one behind a twelve-hour retry
   * -- is the wrong use of the last tokens available.
   */
  parked?: boolean;
}

/**
 * Should this session be named now?
 *
 * The first naming waits for one completed turn -- before that the only thing
 * to go on is the question, and the answer is usually what says what the work
 * is.
 */
export function titleIsDue(state: TitleState): boolean {
  if (state.titleSetByUser) return false;
  if (state.parked) return false;
  // Before a turn has finished, the only thing to go on is the question, and
  // the answer is usually what says what the work is.
  if (state.turns < 1) return false;
  if (state.titledAt === undefined) return true;
  return (state.now ?? Date.now()) - state.titledAt >= RETITLE_AFTER_MS;
}

/**
 * The few messages worth naming from.
 *
 * The opening message anchors what the session was for; the newest ones say
 * where it has got to. The middle is dropped -- it is the bulk of the tokens
 * and the least of the meaning, and sending a whole conversation to name it
 * would cost more than the conversation.
 */
type LoggedEvent = { type: string; text?: unknown };

function messagesOf(events: LoggedEvent[]): Exchange[] {
  const said: Exchange[] = [];
  for (const event of events) {
    const role = event.type === 'user_message' ? 'user' : event.type === 'assistant_text' ? 'assistant' : null;
    if (!role) continue;
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    // A slash command names the tool, not the work.
    if (!text || text.startsWith('/')) continue;
    said.push({ role, text: text.slice(0, MAX_EXCHANGE_CHARS) });
  }
  return said;
}

/**
 * Words that appear in every session and so distinguish none: ordinary English,
 * the vocabulary of doing the work rather than the work, and the shell.
 *
 * The shell half is not optional. Counting whole tool inputs put `command`,
 * `grep`, `head`, `tmp` and `coder` at the top of every session, which is how
 * the subject came to be buried under the transcript of looking for it.
 */
const NOT_A_SUBJECT = new Set(
  `the a an and or but if then than that this these those there here it its is are was were be been
   being do does did doing have has had having will would can could should may might must not no
   yes so as of to in on at by for with from into out up down over under again once all any both
   each few more most other some such only own same too very just now also i you we they he she
   them us our your my me
   file files line lines code test tests testing fix fixes fixed run runs running check checks
   add added adds use used uses using make makes made need needs needed want get gets got put see
   look looks looking work works working error errors fail fails failed failing pass passes passed
   green red build builds commit commits branch main pr prs review ci npm node git diff patch
   merge merged log logs function const let var return type types import export class async await
   null true false undefined string number boolean one two three first second next last new old
   good bad sure okay well right wrong thing things way ways time times
   command description grep head echo tmp src app apps home coder timeout sed awk cat mkdir npx
   python bash tsx json path dir index utils lib components pages shared common config scripts
   frontend backend widgets entities features services rest docs
   probably actually really maybe still already instead perhaps quite rather almost always never
   let's lets please thanks okay sorry yeah nope`
    .split(/\s+/)
    .filter(Boolean),
);

/** Refs that name no work: the trunk, and the machinery of comparing against it. */
const NOT_A_BRANCH =
  /^(?:main|master|trunk|dev|develop|head|origin|upstream|staging|prod|production|above|deleted|--.*)$/i;

/**
 * The branches this session has worked in, best first.
 *
 * The strongest signal there is, and the last one I looked for: a branch name is
 * written by a person to describe the change, which is the exact thing a tab
 * wants to be called. The session that had to be told twice it was about video
 * models was working in `fix/name-the-video-model-on-the-receipt` the whole
 * time.
 *
 * Only tool inputs are read -- what was actually run -- so this is what the
 * session did, not what anyone said about it. Anonymous agent worktrees are
 * skipped: `agent-a019f08d365fbde8e` describes nothing.
 */
export function sessionBranches(events: LoggedEvent[], limit = 3): string[] {
  const counts = new Map<string, number>();
  const bump = (raw: string): void => {
    // A ref, not a range: "main...HEAD" is a comparison, not a place of work.
    if (raw.includes('..')) return;
    const name = raw.replace(/^(?:origin|upstream)\//, '').replace(/\.$/, '');
    const leaf = name.split('/').pop() ?? '';
    if (!leaf || leaf.length < 4 || NOT_A_BRANCH.test(name) || NOT_A_BRANCH.test(leaf)) return;
    // A file is not a branch, however much `fix/thing.md` looks like one.
    if (/\.(?:md|ts|tsx|js|json|py|sql|ya?ml|txt|sh|toml|lock)$/i.test(leaf)) return;
    // An agent worktree is named after the agent, which says nothing.
    if (/^agent-?[0-9a-f]*$/i.test(leaf)) return;
    counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
  };
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    const blob = JSON.stringify((event as { input?: unknown }).input ?? '');
    for (const m of blob.matchAll(/(?:checkout\s+-b|switch\s+-c|--head|--branch)\s+([\w./-]+)/g)) bump(m[1]);
    for (const m of blob.matchAll(/worktrees\/([\w.-]+)/g)) bump(m[1]);
    // No `docs/` or `test/` here, though both are conventional-commit prefixes:
    // they are also real directories, and including them mined the repo for
    // branches called "api md" and "CURRENT STATE FRONTEND md".
    for (const m of blob.matchAll(/\b(?:feat|fix|chore|refactor|probe|perf)\/([\w.-]+)/g)) {
      bump(m[1]);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    // Back into words: a tab is prose, not a ref.
    .map(([name]) => name.replace(/[-_.]+/g, ' ').trim());
}

/**
 * What this session keeps returning to, most frequent first.
 *
 * The signal the message-based versions kept missing. A session about video
 * models said "video" five hundred times across its log and not once in the six
 * messages I was sampling: by the time a long session is being steered, its
 * subject lives in its vocabulary rather than in anything anyone says outright.
 *
 * Weighted by who was speaking -- what the person says counts triple, what the
 * assistant says once -- and by the names of files touched, which are how a
 * codebase says which part of itself is in play. Tool *output* is never counted:
 * it is file contents, and it drowns the subject in whatever happened to be read.
 */
export function sessionVocabulary(events: LoggedEvent[], limit = 10): string[] {
  const counts = new Map<string, number>();
  /** Raw mentions, unweighted: a subject is something said more than once. */
  const mentions = new Map<string, number>();
  const bump = (word: string, by: number): void => {
    const w = word.toLowerCase();
    if (w.length < 3 || NOT_A_SUBJECT.has(w) || /^\d+$/.test(w)) return;
    counts.set(w, (counts.get(w) ?? 0) + by);
    mentions.set(w, (mentions.get(w) ?? 0) + 1);
  };
  for (const event of events) {
    if (event.type === 'user_message' || event.type === 'assistant_text') {
      const text = typeof event.text === 'string' ? event.text.slice(0, 1200) : '';
      const weight = event.type === 'user_message' ? 3 : 1;
      for (const word of text.split(/[^A-Za-z_-]+/)) bump(word, weight);
    } else if (event.type === 'tool_use') {
      const blob = JSON.stringify((event as { input?: unknown }).input ?? '');
      // File names and the directories that hold them, never the command line.
      for (const m of blob.matchAll(/[\w./-]*\/([\w-]+)\.(?:ts|tsx|js|py|sql|md|vue|go|rs|java|rb)/g)) {
        bump(m[1], 2);
      }
      for (const m of blob.matchAll(/\/([A-Za-z][\w-]{3,})\//g)) bump(m[1], 2);
    }
  }
  return [...counts.entries()]
    // Said once, in passing. No stoplist catches every ordinary word -- and it
    // does not have to, because a subject is by definition returned to.
    .filter(([word]) => (mentions.get(word) ?? 0) >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, n]) => `${word} (${n})`);
}

/** Did the person say something here, or only steer? */
function isSubstantive(text: string): boolean {
  return text.length >= MIN_SUBSTANCE_CHARS && !CONTROL_UTTERANCE.test(text);
}

/**
 * The messages worth naming from.
 *
 * Chosen by substance, not by position. Position was the mistake behind every
 * bad name so far: the opening of a long-lived session is "Status" or "restart
 * and continue", and the newest messages are whatever step is in flight, so
 * naming from either end produced "Main merge" and "Backend mypy gate" -- real
 * things, but a fraction of an hour's work rather than what the session is.
 *
 * The person's own messages come first, because they say what is wanted, while
 * the assistant's say what is being done about it. The longest are taken as a
 * proxy for the ones where they explained something, then put back in the order
 * sent so the naming reads the arc rather than a heap. Assistant text is a
 * fallback only: two of ten real sessions contained no substantive user message
 * at all, and for those it is the only evidence there is.
 */
export function pickExchanges(
  opening: LoggedEvent[],
  recent: LoggedEvent[] = opening,
  limit = 6,
): Exchange[] {
  const all = [...messagesOf(opening), ...messagesOf(recent)];
  const seen = new Set<string>();
  const unique = all.filter((e) => {
    if (seen.has(e.text)) return false;
    seen.add(e.text);
    return true;
  });
  const order = new Map(unique.map((e, i) => [e.text, i]));
  const bySubstance = (a: Exchange, b: Exchange): number => b.text.length - a.text.length;
  const chronological = (a: Exchange, b: Exchange): number =>
    (order.get(a.text) ?? 0) - (order.get(b.text) ?? 0);

  const asked = unique.filter((e) => e.role === 'user' && isSubstantive(e.text));
  if (asked.length > 0) {
    return [...asked].sort(bySubstance).slice(0, limit).sort(chronological);
  }
  // Nothing was ever asked in words: the work is only visible in the replies.
  const replied = unique.filter((e) => e.role === 'assistant' && isSubstantive(e.text));
  return [...replied].sort(bySubstance).slice(0, 2).sort(chronological);
}

export function titlePrompt(
  exchanges: Exchange[],
  siblings: string[] = [],
  vocabulary: string[] = [],
  branches: string[] = [],
  issue = '',
  current = '',
): string {
  const body = exchanges
    .map((e) => `<${e.role}>\n${e.text}\n</${e.role}>`)
    .join('\n\n');
  // The other tabs, so this name can be told apart from them. Without this the
  // namer works blind and produces "Receipt backend" next to "Backend
  // typecheck" -- both fair names, together useless.
  const others = siblings.length
    ? `\n\nOther tabs already open in this project, which your name must not be confusable with:\n${siblings
        .map((t) => `- ${t}`)
        .join('\n')}`
    : '';
  // Branches first: a person wrote these to describe the change, which is the
  // thing a tab wants to be called.
  const worked = branches.length
    ? `\n\nBranches this session has worked in. Someone named these to describe the change, so they are the best evidence of the subject:\n${branches
        .map((b) => `- ${b}`)
        .join('\n')}`
    : '';
  // Told, not enforced: several issues at once usually means a run of bug
  // fixes, and sometimes does not. The namer has the rest of the evidence and
  // can weigh this against it -- a rule here would be wrong the times it is
  // wrong, silently.
  const many = issue.endsWith('+')
    ? `\n\nSeveral issues are in play (${issue.slice(0, -1)} and others). That usually means a run of bug fixes rather than one subject: if they share a theme, name the theme; if they only share being broken, say what the run is over. It is not always bug fixing, so weigh this against everything else here.`
    : '';
  // What it is called now. Most re-namings are of a session that simply carried
  // on, and a tab you have learned to recognise must not be reworded for the
  // sake of it -- only a subject that has actually become something else earns
  // a new name.
  const already = current
    ? `\n\nThis conversation is currently called "${current}". It has been working for a while since that was chosen. If it is still about the same thing, reply with that name unchanged. Give a different name only if the subject has genuinely become something else.`
    : '';
  const subject = vocabulary.length
    ? `\n\nWords this session keeps returning to, most frequent first:\n${vocabulary.join(', ')}`
    : '';
  return `Name this conversation for a tab strip.${already}${worked}${many}${subject}\n\n${body}${others}`;
}

/**
 * The three letters that say which project a tab belongs to.
 *
 * Taken from the directory, not asked for: it is already known, it never
 * changes, and a model would only paraphrase it.
 *
 * Consonants rather than the first three characters, because a skeleton stays
 * recognisable where a truncation does not: `blooper` reads as `blp` and
 * `claude-persist` as `cld`, while cutting at three gives `blo` and `cla` --
 * and `cla` is what `claude-code`, `clang` and `classifier` all shorten to.
 * The first character is always kept, vowel or not, since that is the letter
 * you look for.
 */
export function projectTag(cwd: string): string {
  const clean = path.basename(cwd).replace(/[^A-Za-z0-9]/g, '');
  const letters = clean.replace(/[^A-Za-z]/g, '');
  // Letters win when there are any to speak of, so `2026-audit` reads `adt`
  // rather than `202`.
  const source = letters.length >= 2 ? letters : clean;
  if (!source) return '';
  const [first, ...rest] = source;
  const skeleton = first + rest.join('').replace(/[aeiou]/gi, '');
  // A word with too few consonants keeps its vowels rather than coming up short.
  const tag = skeleton.length >= 3 ? skeleton : source;
  return tag.slice(0, 3).toLowerCase();
}

/**
 * The issue or pull request this session is about, or empty.
 *
 * A number is the fastest thing to pick out of a strip: with ten tabs on ten
 * pull requests, `#1226` finds the one you mean before any wording does, and it
 * is what you already have in your head when you go looking. One real session
 * mentioned its PR three hundred and thirty-five times.
 *
 * Counted from prose as well as tool inputs, since a review session talks about
 * its number far more often than it runs a command against it. A minimum keeps
 * a passing mention of somebody else's issue out of the name.
 *
 * Returns `#1226` when one is clearly the subject, `#1226+` when several are in
 * play, and nothing when none is mentioned enough to matter. An issue and its
 * pull request share a number, so "#1354" and "pull/1354" count as one thing.
 */
export function sessionIssue(events: LoggedEvent[], min = 5): string {
  const counts = new Map<string, number>();
  const bump = (n: string): void => {
    counts.set(n, (counts.get(n) ?? 0) + 1);
  };
  for (const event of events) {
    const text =
      event.type === 'tool_use'
        ? JSON.stringify((event as { input?: unknown }).input ?? '')
        : typeof event.text === 'string'
          ? event.text
          : '';
    if (!text) continue;
    // "#1226", "issues/1226", and "gh pr view 1226" -- the verb sits between the
    // word and the number, which the first version of this missed.
    for (const m of text.matchAll(/(?:#(\d{2,6})|(?:issues?|pull|pr)\b[^\d\n]{0,14}?(\d{2,6}))\b/gi)) {
      bump(m[1] ?? m[2]);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < min) return '';
  // Several in play, none of them the tab's subject on its own. One real
  // session swept five issues at once -- #808, #835, #759, #867, #751 -- and
  // labelling it "#835" claimed something untrue. The plus says "and others",
  // for one character, and still gives you a number to find it by.
  const dominant = !second || best[1] >= second[1] * 2;
  return dominant ? `#${best[0]}` : `#${best[0]}+`;
}

/**
 * `blp|#1226+ roaming chat history` -- tag, issue, name, in order of how fast
 * each tells you which tab this is.
 *
 * The number rides outside the name's twenty characters rather than inside
 * them. Sharing the budget cost more than it looked: `#1354+ ` is seven
 * characters, and "video continuation" came out as "Video", "roaming chat
 * history" as "Roaming". A number locates a tab and describes nothing, so
 * taking a third of the description to carry it was the wrong trade.
 */
export function composeTitle(tag: string, name: string, issue = ''): string {
  const label = issue ? `${issue} ${name}`.trim() : name;
  return tag ? `${tag}|${label}` : label;
}

/**
 * Words that fit any session and so identify none.
 *
 * A tab name has twenty characters. "Continuity testing" spent eight of them on
 * "testing", which was true of half the sessions open at the time. These are
 * dropped from a name rather than the name being rejected: what is left is
 * usually the part that was doing the work.
 */
const FILLER = new Set([
  'work', 'works', 'working', 'fix', 'fixes', 'fixing', 'issue', 'issues',
  'task', 'tasks', 'testing', 'tests', 'test', 'update', 'updates', 'updating',
  'change', 'changes', 'review', 'reviewing', 'improvement', 'improvements',
  'refactor', 'refactoring', 'implementation', 'implementing', 'support',
  'session', 'conversation', 'debug', 'debugging', 'investigation', 'stuff',
]);

/**
 * Sentence case, filler removed, and never repeating the project.
 *
 * Done here rather than asked for: a model told four style rules obeys two of
 * them, and a strip of tabs in three capitalisations is harder to scan than one
 * in a single style.
 */
/**
 * A word reduced to something two spellings of it share.
 *
 * Crude on purpose: "worktree" and "worktrees" must count as the same word, and
 * five characters gets that without a stemmer. It only ever has to decide
 * whether two short names are saying the same thing.
 */
function stem(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
}

export function tidyName(name: string, project = ''): string | null {
  // Split on non-letters, not non-alphanumerics: "blooper2.0" has to yield
  // "blooper", or a name repeating the project sails straight through.
  const projectStems = new Set(
    project
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2)
      .map(stem),
  );
  // An identifier is not prose: "action_router" and "routing-receipt" come
  // straight out of the vocabulary, and a tab called "Action_router leaks" reads
  // like a stack trace.
  const words = name.replace(/[_]+/g, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => {
    const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    // The tag already says which project; saying it again costs half the name.
    return bare && !FILLER.has(bare) && !projectStems.has(stem(w));
  });
  // Every word was filler: there was no name here, only a shape.
  if (kept.length === 0) return null;
  // "Mutation testing" is a technique, not mutation plus filler, and dropping
  // the word left a tab called "Mutation". Filler only goes when something
  // stands without it.
  if (kept.length < 2 && words.length >= 2) {
    return sentenceCase(words.filter((w) => !projectStems.has(stem(w))));
  }
  return sentenceCase(kept);
}

/**
 * The first word capitalised and the rest left low, except an all-caps word,
 * which is an initialism and keeps itself: CI, SQL, API.
 */
function sentenceCase(words: string[]): string | null {
  if (words.length === 0) return null;
  return words
    .map((w, i) => {
      if (w === w.toUpperCase()) return w;
      const lower = w.toLowerCase();
      return i === 0 ? lower[0].toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

/**
 * Is the new name worth the strip changing under you?
 *
 * A re-naming that only rephrases -- "Git worktrees" to "Worktree handling" --
 * moves the tab you had learned to recognise and tells you nothing new. Names
 * sharing most of their significant words are treated as the same name.
 */
export function isMaterialChange(current: string, next: string): boolean {
  const words = (t: string): Set<string> =>
    new Set(
      t
        .toLowerCase()
        .replace(/^[a-z0-9]{1,3}\|/, '')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3)
        // Stemmed, or a plural reads as a different word and every rephrase
        // looks like news: "worktrees" to "worktree handling".
        .map(stem),
    );
  const before = words(current);
  const after = words(next);
  if (after.size === 0) return false;
  let shared = 0;
  for (const w of after) if (before.has(w)) shared += 1;
  // Worth it only when fewer than half the new name's significant words were
  // already being said. At exactly half -- "Git worktrees" to "Worktree
  // pruning" -- the subject has not changed, only the detail, and stability is
  // worth more than the detail.
  return shared * 2 < after.size;
}

const SYSTEM_PROMPT = [
  'You name conversations for an editor tab strip, where twenty characters have to',
  'let someone pick this tab out of twenty others at a glance.',
  'Reply with the name alone: at most 20 characters, no quotes, no trailing period, no preamble.',
  'Do not include an issue or pull request number -- one is added for you, and',
  'repeating it costs you the words you have.',
  'A branch name, where there is one, is the best evidence you have: a person',
  'wrote it to describe the change. Prefer what it says over everything else,',
  'shortened to fit. The word list is next: it is what the session actually spent',
  'its time on. The messages show what the person asked for, in',
  'the order sent, but by the time a session is long they are mostly steering --',
  'a loud complaint that nothing works says nothing about the work.',
  'Name the subject the words point to, as a noun phrase: "video model routing",',
  '"generation queue", "signup emails".',
  'Do not name a step taken along the way: merging, CI, typechecks, screenshots,',
  'test runs and reviews are how the work proceeds, not what it is, unless the',
  'person asked about that thing itself. Do not name the general area either',
  '("frontend work"), which fits every other tab too.',
  'Never repeat the project name, and never use filler that would fit any session:',
  'work, fix, issue, task, testing, update, review, changes.',
  'If other tabs are listed, yours must be distinguishable from all of them: when',
  'the area is the same, name what is different about this one.',
].join(' ');

/**
 * A usable title, or null if the model answered with something else.
 *
 * Null rather than a salvage attempt: a bad name is worse than the one already
 * there, and the caller keeps what it has. Clamping prose down to six words
 * produces a confident-looking fragment of a sentence, which is exactly the
 * failure that would be hardest to notice.
 */
export function cleanTitle(raw: string): string | null {
  const firstLine = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  const stripped = firstLine
    // Models label their answers even when told not to.
    .replace(/^(?:title|name)\s*[:\-]\s*/i, '')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    .trim();
  if (!stripped) return null;
  if (stripped.split(' ').length > MAX_TITLE_WORDS) return null;
  if (NOT_A_TITLE.test(stripped)) return null;
  if (stripped.length <= MAX_NAME_CHARS) return stripped;
  // Over budget but still name-shaped: cut at a word boundary rather than
  // mid-word, and keep whatever whole words fit.
  const cut = stripped.slice(0, MAX_NAME_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,;:-]$/, '').trim();
}

export interface TitleRequest {
  exchanges: Exchange[];
  /** What the other tabs in this project are called, so this one differs. */
  siblings?: string[];
  /** The project name, so the name does not spend characters repeating it. */
  project?: string;
  /** What the session keeps returning to. */
  vocabulary?: string[];
  /** Branches worked in: a person's own description of the change. */
  branches?: string[];
  /** The issue in hand, `#1226+` when there are several. */
  issue?: string;
  /** What the tab is called now, so a continuation keeps its name. */
  current?: string;
  /** The account this session runs on, so the naming is billed where the work is. */
  configDir: string;
  /** Where the throwaway transcript lands; not the session's own directory. */
  cwd: string;
  claudeBin?: string;
}

/**
 * Ask for a name. Null on anything going wrong -- this is a nicety, and a
 * session must never fail, stall, or lose a turn over what its tab says.
 */
export async function generateTitle(
  req: TitleRequest,
  run: typeof query = query,
): Promise<string | null> {
  if (req.exchanges.length === 0) return null;
  try {
    const q = run({
      prompt: titlePrompt(
        req.exchanges,
        req.siblings ?? [],
        req.vocabulary ?? [],
        req.branches ?? [],
        req.issue ?? '',
        req.current ?? '',
      ),
      options: {
        model: TITLE_MODEL,
        maxTurns: 1,
        // The whole reason this is affordable: no tool definitions, and none of
        // the user's CLAUDE.md or skills, in a call that only reads four short
        // messages.
        tools: [],
        settingSources: [],
        systemPrompt: SYSTEM_PROMPT,
        cwd: req.cwd,
        ...(req.claudeBin ? { pathToClaudeCodeExecutable: req.claudeBin } : {}),
        env: { ...process.env, CLAUDE_CONFIG_DIR: req.configDir },
      },
    });
    for await (const message of q) {
      if (message.type !== 'result') continue;
      const result = message as { subtype?: string; is_error?: boolean; result?: unknown };
      // A failure arrives as an ordinary result whose text is the error --
      // "Failed to authenticate: OAuth session expired" is six words and looks
      // exactly like a title. Caught by running this for real against an
      // account whose login had lapsed, which is how it nearly became one.
      if (result.is_error || result.subtype !== 'success') return null;
      const cleaned = cleanTitle(typeof result.result === 'string' ? result.result : '');
      return cleaned === null ? null : tidyName(cleaned, req.project ?? '');
    }
    return null;
  } catch {
    return null;
  }
}
