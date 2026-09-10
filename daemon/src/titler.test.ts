import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_NAME_CHARS,
  composeTitle,
  projectTag,
  RETITLE_AFTER_MS,
  cleanTitle,
  generateTitle,
  isMaterialChange,
  tidyName,
  pickExchanges,
  sessionBranches,
  sessionIssue,
  sessionVocabulary,
  titleIsDue,
  titlePrompt,
} from './titler.js';

// ---------- when to ask -----------------------------------------------------

/**
 * A tab is named at the one moment nobody knows what the work is: creation.
 * The first answer is usually what says what it turned out to be.
 */
test('due after the first completed turn, not before', () => {
  assert.equal(titleIsDue({ turns: 0 }), false, 'the question alone is not enough to go on');
  assert.equal(titleIsDue({ turns: 1 }), true);
});

/**
 * Time, not turns: a turn is anything from a one-word answer to an hour of
 * work, so counting them measures nothing anyone can feel.
 */
test('not looked at again for twenty minutes', () => {
  const at = 1_000_000;
  assert.equal(titleIsDue({ turns: 9, titledAt: at, now: at + 60_000 }), false, 'a minute later');
  assert.equal(
    titleIsDue({ turns: 9, titledAt: at, now: at + RETITLE_AFTER_MS - 1 }),
    false,
    'a moment short of twenty minutes',
  );
  assert.equal(titleIsDue({ turns: 9, titledAt: at, now: at + RETITLE_AFTER_MS }), true);
});

/**
 * "Twenty minutes" means twenty minutes of working in the tab: this is only
 * ever asked when a turn completes, so a tab nobody touches for a week is never
 * re-named and never costs a call.
 */
test('a tab with no activity is never looked at, however long it sits', () => {
  // A week later, but the turn count says nothing has happened since.
  assert.equal(titleIsDue({ turns: 0, titledAt: 1, now: 1 + 7 * 24 * 3600_000 }), false);
});

/** A name you chose is a decision. Nothing generated overrides a decision. */
test('a name you set yourself is never replaced', () => {
  assert.equal(titleIsDue({ turns: 500, titledAt: 1, titleSetByUser: true }), false);
  assert.equal(titleIsDue({ turns: 1, titleSetByUser: true }), false);
});

/**
 * A parked turn is waiting for room on a rate-limited or overloaded account.
 * Naming a tab is not what the last of the quota is for, and a title queued
 * behind a twelve-hour retry would arrive long after anyone cared.
 */
test('nothing is named while a turn is parked', () => {
  assert.equal(titleIsDue({ turns: 1, parked: true }), false);
  assert.equal(titleIsDue({ turns: 40, titledAt: 1, parked: true }), false);
  assert.equal(titleIsDue({ turns: 40, titledAt: 1, parked: false }), true);
});

// ---------- what to name from ----------------------------------------------

const said = (n: number): { type: string; text: string } => ({
  type: n % 2 === 0 ? 'user_message' : 'assistant_text',
  text: `a substantive message number ${n} about the work`,
});

/**
 * Position was the mistake behind every bad name. Ten real sessions opened with
 * "Status", "restart and continue" and "3 then 1", and ended mid-step, so
 * naming from either end produced "Main merge" and "Backend mypy gate": real
 * things, but a fraction of an hour rather than what the session is.
 */
test('steering is not what the work is', () => {
  const picked = pickExchanges([
    { type: 'user_message', text: 'Status' },
    { type: 'user_message', text: 'restart and continue' },
    { type: 'user_message', text: '3 then 1' },
    { type: 'user_message', text: 'So what should we do?' },
    { type: 'user_message', text: 'What you need from me' },
    { type: 'user_message', text: 'Queue should go to the generation runs list' },
  ]);
  assert.deepEqual(
    picked.map((p) => p.text),
    ['Queue should go to the generation runs list'],
  );
});

test('a nudge is too short to be a statement of work', () => {
  const picked = pickExchanges([
    { type: 'user_message', text: 'go on' },
    { type: 'user_message', text: 'yes do that' },
    { type: 'user_message', text: 'Fix the container leak and D5' },
  ]);
  assert.deepEqual(picked.map((p) => p.text), ['Fix the container leak and D5']);
});

/** What the person wants, not what is being done about it. */
test('the person messages are preferred over the replies', () => {
  const picked = pickExchanges([
    { type: 'assistant_text', text: 'Merging now. Checking CI on the current head first.' },
    { type: 'user_message', text: 'Can it tell if a video continues another video?' },
    { type: 'assistant_text', text: 'Reproduced: partialThoughts is undefined at use-agent-transcript' },
  ]);
  assert.deepEqual(picked.map((p) => p.role), ['user']);
});

/**
 * Two of ten real sessions contained no substantive user message at all -- only
 * "Status" and "continue" -- and for those the replies are the only evidence
 * there is.
 */
test('the replies are used when nothing was ever asked in words', () => {
  const picked = pickExchanges([
    { type: 'user_message', text: 'Status' },
    { type: 'assistant_text', text: 'The registration page now sends invite and reset emails.' },
  ]);
  assert.deepEqual(picked.map((p) => p.role), ['assistant']);
  assert.match(picked[0].text, /registration page/);
});

test('the chosen messages read in the order they were sent', () => {
  const picked = pickExchanges([
    { type: 'user_message', text: 'First, we need a registration page for blooper' },
    { type: 'user_message', text: 'Now the invite emails and the password reset ones as well' },
  ]);
  assert.deepEqual(picked.map((p) => p.text.slice(0, 5)), ['First', 'Now t']);
});

/**
 * Six rather than four: one loud message -- "be sure that you work! you don't
 * work now!" -- named a real session "Agent operability", and the cure for a
 * bad sample is more of it.
 */
test('substance decides which are kept when there are many', () => {
  const picked = pickExchanges(Array.from({ length: 20 }, (_, i) => said(i * 2)));
  assert.equal(picked.length, 6, 'six is the budget');
});

test('tool calls and deltas are not messages', () => {
  const picked = pickExchanges([
    { type: 'tool_use', text: 'Bash and a good long description of it' },
    { type: 'user_message', text: 'Fix the preview wrapper sizing' },
    { type: 'status', text: 'running the whole of the test suite now' },
  ]);
  assert.deepEqual(picked, [{ role: 'user', text: 'Fix the preview wrapper sizing' }]);
});

/** "/clear" names the tool, not the work -- and it is a common first message. */
test('a slash command is not what the session is about', () => {
  const picked = pickExchanges([
    { type: 'user_message', text: '/clear' },
    { type: 'user_message', text: 'We need a registration page for blooper' },
  ]);
  assert.deepEqual(picked, [{ role: 'user', text: 'We need a registration page for blooper' }]);
});

test('a long message is cut before it can dominate the prompt', () => {
  const picked = pickExchanges([{ type: 'user_message', text: 'x'.repeat(5000) }]);
  assert.equal(picked[0].text.length, 300);
});

test('the prompt carries the exchange with its roles', () => {
  const prompt = titlePrompt([
    { role: 'user', text: 'grey strip beside the video' },
    { role: 'assistant', text: 'the wrapper is wider than the frame' },
  ]);
  assert.match(prompt, /<user>\ngrey strip beside the video\n<\/user>/);
  assert.match(prompt, /<assistant>\nthe wrapper is wider than the frame\n<\/assistant>/);
});

// ---------- what comes back -------------------------------------------------

test('an ordinary answer is taken as it is', () => {
  assert.equal(cleanTitle('Post-merge CI'), 'Post-merge CI');
  // Twenty characters exactly: the budget is inclusive.
  assert.equal(cleanTitle('Registration page fix'.slice(0, 20)), 'Registration page fi');
});

/** Models label and quote their answers even when told not to. */
test('labels, quotes and full stops are stripped', () => {
  assert.equal(cleanTitle('Title: "Registration page"'), 'Registration page');
  assert.equal(cleanTitle('“Registration page”'), 'Registration page');
  assert.equal(cleanTitle('Registration page.'), 'Registration page');
  assert.equal(cleanTitle('  Registration   page  '), 'Registration page');
});

test('only the first line, when it answered in several', () => {
  assert.equal(cleanTitle('Registration page\n\nLet me know if...'), 'Registration page');
});

/**
 * Null, not a salvage. Clamping prose to six words makes a confident-looking
 * fragment of a sentence -- the failure that would be hardest to notice -- and
 * the caller keeping the name it already has is always the better outcome.
 */
test('prose is refused rather than trimmed into a title', () => {
  const prose =
    'I would suggest naming this conversation something about the video preview ' +
    'because that is what you were mainly working on here';
  assert.equal(cleanTitle(prose), null);
});

test('an empty or blank answer is refused', () => {
  assert.equal(cleanTitle(''), null);
  assert.equal(cleanTitle('   \n  '), null);
  assert.equal(cleanTitle('""'), null);
});

test('a long-but-name-shaped answer is cut at a word boundary', () => {
  const name = cleanTitle('Registration page invite emails and password reset');
  assert.ok(name);
  assert.ok(name.length <= MAX_NAME_CHARS, `${name} is over budget`);
  assert.ok(!name.endsWith(' '), 'no trailing space where the cut fell');
  assert.equal(name, 'Registration page', 'whole words, from the front');
});

// ---------- the shape of a tab name -----------------------------------------

/**
 * A tab strip shows several at once, so the three letters that say which
 * project come first and the budget is spent on the part that differs.
 */
/**
 * A skeleton stays recognisable where a truncation does not: `cla` is what
 * `claude-code`, `clang` and `classifier` all shorten to, while `cld` is only
 * ever claude-persist.
 */
test('the tag is a consonant skeleton, taken from the directory', () => {
  assert.equal(projectTag('/home/me/code/blooper2.0'), 'blp');
  assert.equal(projectTag('/home/me/code/claude-persist'), 'cld');
  assert.equal(projectTag('/srv/API'), 'api', 'a tag is lowercase whatever the folder is');
});

test('the first letter is kept whether or not it is a vowel', () => {
  assert.equal(projectTag('/home/me/audit'), 'adt');
  assert.equal(projectTag('/home/me/orchestrator'), 'orc');
});

test('a word with too few consonants keeps its vowels rather than coming up short', () => {
  assert.equal(projectTag('/home/me/api'), 'api');
  assert.equal(projectTag('/home/me/aioli'), 'aio');
});

test('letters win over digits, and punctuation counts for nothing', () => {
  assert.equal(projectTag('/home/me/2026-audit'), 'adt');
  assert.equal(projectTag('/home/me/-x-'), 'x');
  assert.equal(projectTag('/home/me/v2'), 'v2', 'too few letters to skeletonise');
});

test('a directory with no letters at all yields no tag', () => {
  assert.equal(projectTag('/home/me/code/---'), '');
  assert.equal(composeTitle('', 'Registration page'), 'Registration page');
});

test('the two halves join with a bar', () => {
  assert.equal(composeTitle('blo', 'Post-merge CI'), 'blo|Post-merge CI');
});

test('the name itself still fits twenty, whatever rides in front of it', () => {
  const name = cleanTitle('Roaming fix shipped clean worktrees') ?? '';
  const title = composeTitle(projectTag('/home/me/blooper2.0'), name);
  assert.ok(name.length <= MAX_NAME_CHARS, `${name} is over budget`);
  assert.ok(title.length <= MAX_NAME_CHARS + 4, `${title} is too wide for a tab`);
  assert.match(title, /^blp\|/);
});

// ---------- the call itself -------------------------------------------------

type QueryFn = Parameters<typeof generateTitle>[1];

function answering(
  text: string,
  seen: Record<string, unknown>[] = [],
  extra: Record<string, unknown> = {},
): QueryFn {
  return ((args: Record<string, unknown>) => {
    seen.push(args);
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: text, ...extra };
    })();
  }) as unknown as QueryFn;
}

const REQ = {
  exchanges: [{ role: 'user' as const, text: 'grey strip beside the video' }],
  configDir: '/home/me/.claude-accounts/work',
  cwd: '/home/me',
};

test('the answer becomes the title', async () => {
  assert.equal(await generateTitle(REQ, answering('Video wrapper sizing')), 'Video wrapper sizing');
});

/**
 * The whole reason this is affordable. Measured on a real exchange: with the
 * built-in tools left in, one title costs 18,175 tokens of cache-write, because
 * Claude Code ships its entire tool surface to a model that will never call
 * one. With them off the same call is ~730 tokens.
 */
test('it asks with no tools and none of your settings', async () => {
  const seen: Record<string, unknown>[] = [];
  await generateTitle(REQ, answering('Video wrapper sizing', seen));
  const options = seen[0].options as Record<string, unknown>;
  assert.deepEqual(options.tools, [], 'tool definitions are 25x the cost of the question');
  assert.deepEqual(options.settingSources, [], 'CLAUDE.md and skills have no business here');
  assert.equal(options.maxTurns, 1);
});

/** Named on the account the work runs on, not whichever one the daemon inherited. */
test('it runs on the session own account', async () => {
  const seen: Record<string, unknown>[] = [];
  await generateTitle(REQ, answering('Video wrapper sizing', seen));
  const env = (seen[0].options as { env: Record<string, string> }).env;
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/me/.claude-accounts/work');
});

test('nothing to name from, nothing asked', async () => {
  let asked = 0;
  const counting = ((): never => {
    asked += 1;
    throw new Error('should not have been called');
  }) as unknown as QueryFn;
  assert.equal(await generateTitle({ ...REQ, exchanges: [] }, counting), null);
  assert.equal(asked, 0);
});

/** A tab name must never cost a turn, so every failure is simply no title. */
test('a failed call is no title, not an error', async () => {
  const throwing = (() => {
    throw new Error('spawn ENOENT');
  }) as unknown as QueryFn;
  assert.equal(await generateTitle(REQ, throwing), null);

  const silent = (() =>
    (async function* () {
      // ends without ever producing a result
    })()) as unknown as QueryFn;
  assert.equal(await generateTitle(REQ, silent), null);

});

/**
 * Length alone does not catch these -- "I cannot name this for you today" is
 * seven words, well inside the limit, and would have gone onto a tab.
 */
test('an answer that is not a title is refused, however short', () => {
  assert.equal(cleanTitle('I cannot name this for you today'), null);
  assert.equal(cleanTitle('Sure! Registration page'), null);
  assert.equal(cleanTitle('Here is a title'), null);
  // And a real name that merely starts with an ordinary word still passes.
  assert.equal(cleanTitle('Invite import flow'), 'Invite import flow');
  assert.equal(cleanTitle('Okta login redirect'), 'Okta login redirect');
});

/**
 * The one a real run caught. A failed call is not an exception -- it is an
 * ordinary result whose text is the error, and "Failed to authenticate: OAuth
 * session expired" is six words that pass every shape check a title has. It
 * was one dry run away from renaming a tab to it.
 */
test('an error dressed as a result is not a title', async () => {
  assert.equal(
    await generateTitle(
      REQ,
      answering('Failed to authenticate: OAuth session expired', [], {
        subtype: 'error_during_execution',
        is_error: true,
      }),
    ),
    null,
  );
  // is_error alone is enough, whatever the subtype claims.
  assert.equal(
    await generateTitle(REQ, answering('Something went wrong', [], { is_error: true })),
    null,
  );
  // And a subtype that is not success, however clean the text looks.
  assert.equal(
    await generateTitle(REQ, answering('Video wrapper sizing', [], { subtype: 'error_max_turns' })),
    null,
  );
});

// ---------- picking a name out of twenty ------------------------------------

/**
 * The failure the first version shipped with, seen on ten real sessions: it
 * produced "Receipt backend" beside "Backend typecheck", and "PR review and
 * merge" beside "Merge workflow". Each name was fair on its own; together they
 * told you nothing about which tab to click. A namer cannot avoid that without
 * being shown the other tabs.
 */
test('the other tabs are shown, so a name can be told from them', () => {
  const prompt = titlePrompt([{ role: 'user', text: 'the receipt block' }], [
    'blp|Backend typecheck',
    'blp|Merge workflow',
  ]);
  assert.match(prompt, /Backend typecheck/);
  assert.match(prompt, /Merge workflow/);
  assert.match(prompt, /not be confusable/i);
});

test('with no other tabs, nothing is said about them', () => {
  const prompt = titlePrompt([{ role: 'user', text: 'the receipt block' }], []);
  assert.doesNotMatch(prompt, /Other tabs/);
});

/**
 * Twenty characters, and "testing" was eating eight of them while being true
 * of half the sessions open at the time.
 */
/**
 * Filler goes only while something stands without it. "Mutation testing" and
 * "Continuity testing" cannot be told apart by any rule short of a lexicon, and
 * of the two mistakes, a slightly generic pair beats a vague singleton.
 */
test('filler is dropped, while two words remain', () => {
  assert.equal(tidyName('Receipt backend testing'), 'Receipt backend');
  assert.equal(tidyName('PR review and merge'), 'PR and merge');
  assert.equal(tidyName('Continuity testing'), 'Continuity testing', 'better than "Continuity"');
  assert.equal(tidyName('Worktree cleanup'), 'Worktree cleanup', 'cleanup says what happened to them');
});

/**
 * "Mutation testing" is a technique, not mutation plus filler. Stripping the
 * word left a real session called "Mutation".
 */
test('filler stays when it is half a term of art', () => {
  assert.equal(tidyName('Mutation testing'), 'Mutation testing');
  assert.equal(tidyName('Load testing'), 'Load testing');
  // But with something left standing, it still goes.
  assert.equal(tidyName('Receipt backend testing'), 'Receipt backend');
});

test('a name that was only filler is refused', () => {
  assert.equal(tidyName('Testing fixes'), null);
  assert.equal(tidyName('Work'), null);
});

/** The tag already said which project; saying it again costs half the name. */
test('the project name is not repeated', () => {
  assert.equal(tidyName('Blooper email escaping', 'blooper2.0'), 'Email escaping');
  assert.equal(tidyName('Claude persist titles', 'claude-persist'), 'Titles');
});

/** A strip in three capitalisations is harder to scan than one in a single style. */
test('one style, but an initialism keeps itself', () => {
  assert.equal(tidyName('Transactional Mail'), 'Transactional mail');
  assert.equal(tidyName('ci pipeline'), 'Ci pipeline');
  assert.equal(tidyName('CI pipeline'), 'CI pipeline');
  assert.equal(tidyName('SQL migrations'), 'SQL migrations');
});

/**
 * A re-naming that only rephrases moves a tab you had learned to recognise and
 * tells you nothing new.
 */
test('a rephrase is not a change worth making', () => {
  assert.equal(isMaterialChange('blp|Git worktrees', 'blp|Worktree handling'), false);
  assert.equal(isMaterialChange('blp|Video continuity', 'blp|Continuity of video'), false);
});

test('but real movement is', () => {
  assert.equal(isMaterialChange('blp|Git worktrees', 'blp|Signup emails'), true);
  assert.equal(isMaterialChange('blooper2.0-lenya', 'blp|Git worktrees'), true);
});

test('a name with nothing significant in it never replaces one that has', () => {
  assert.equal(isMaterialChange('blp|Git worktrees', 'blp|CI'), false);
});

// ---------- naming from both ends of a long session -------------------------

/**
 * The log cannot give both ends in one read: asking it for events since 0 with
 * a limit returns the *newest* that many. Naming from that window's oldest
 * entry called tabs after whatever the session was doing yesterday afternoon.
 */
test('both ends of a long session are considered, not just one', () => {
  const opening = [{ type: 'user_message', text: 'build a registration page for blooper' }];
  const recent = [
    { type: 'assistant_text', text: 'middle of the work' },
    { type: 'user_message', text: 'now the invite emails and the reset ones' },
  ];
  const picked = pickExchanges(opening, recent);
  assert.equal(picked[0].text, 'build a registration page for blooper', 'what it was for');
  assert.equal(
    picked[picked.length - 1].text,
    'now the invite emails and the reset ones',
    'where it has got to',
  );
});

test('an opening that is also among the newest is not sent twice', () => {
  const only = [{ type: 'user_message', text: 'build a registration page for blooper' }];
  assert.deepEqual(pickExchanges(only, only), [
    { role: 'user', text: 'build a registration page for blooper' },
  ]);
});

// ---------- what the session keeps returning to -----------------------------

/**
 * The signal every message-based version missed. A real session about video
 * models said "video" five hundred times across its log and not once in the six
 * messages being sampled -- by the time a long session is being steered, its
 * subject is in its vocabulary rather than in anything said outright.
 */
test('vocabulary: the subject is what recurs, weighted to the person', () => {
  const events = [
    { type: 'user_message', text: 'the video model provider is picking the wrong one' },
    { type: 'assistant_text', text: 'Routing receipt records which model a video job went to' },
    { type: 'assistant_text', text: 'the receipt is written once per video generation' },
  ];
  const vocab = sessionVocabulary(events, 4).map((v) => v.split(' ')[0]);
  assert.ok(vocab.includes('video'), `video should lead: ${vocab.join(', ')}`);
  assert.ok(vocab.includes('model'));
});

/**
 * Counting whole tool inputs put "command", "grep", "head" and "tmp" at the top
 * of every session -- the subject buried under the transcript of looking for it.
 */
test('vocabulary: the shell is not a subject', () => {
  const events = [
    { type: 'tool_use', input: { command: 'grep -rn receipts /tmp/out | head -20', description: 'Grep' } },
    { type: 'tool_use', input: { command: 'echo hi' } },
    { type: 'user_message', text: 'the receipts are wrong; every receipts row is' },
  ];
  const vocab = sessionVocabulary(events, 6).map((v) => v.split(' ')[0]);
  for (const noise of ['command', 'grep', 'head', 'tmp', 'echo', 'description']) {
    assert.ok(!vocab.includes(noise), `${noise} is not what any session is about`);
  }
  assert.ok(vocab.includes('receipts'));
});

/** A codebase says which part of itself is in play by which files are touched. */
test('vocabulary: the files touched count, their contents do not', () => {
  const events = [
    // Touched more than once, as a file being worked on is: the real session
    // this came from touched its generation-menu 266 times.
    { type: 'tool_use', input: { file_path: '/app/frontend/widgets/generation-menu/status-chips.ts' } },
    { type: 'tool_use', input: { file_path: '/app/frontend/widgets/generation-menu/status-chips.ts' } },
    { type: 'tool_result', text: 'export const somethingEntirelyDifferent everywhere and somethingEntirelyDifferent' },
  ];
  const vocab = sessionVocabulary(events, 6).map((v) => v.split(' ')[0]);
  assert.ok(vocab.includes('status-chips'), `${vocab.join(', ')}`);
  assert.ok(vocab.includes('generation-menu'), 'the directory names the feature');
  assert.ok(
    !vocab.includes('somethingentirelydifferent'),
    'tool output is file contents and would drown the subject',
  );
});

/**
 * No stoplist catches every ordinary word -- "probably" got through the first
 * one. It does not have to: a subject is by definition something the session
 * returns to, so anything said once is not one.
 */
test('vocabulary: said once is not a subject, whatever the word', () => {
  const events = [{ type: 'user_message', text: 'we should probably just fix the tests and run them again' }];
  assert.deepEqual(sessionVocabulary(events, 8), [], 'nothing here says what the work is');
});

test('vocabulary: said twice is', () => {
  const events = [
    { type: 'user_message', text: 'the moodboard is wrong' },
    { type: 'assistant_text', text: 'the moodboard renders before its images load' },
  ];
  assert.equal(sessionVocabulary(events, 8)[0].split(' ')[0], 'moodboard');
});

test('the prompt leads with the vocabulary, since that is the evidence', () => {
  const prompt = titlePrompt(
    [{ role: 'user', text: 'the provider is wrong' }],
    [],
    ['video (509)', 'model (348)'],
  );
  assert.match(prompt, /video \(509\), model \(348\)/);
  assert.ok(
    prompt.indexOf('video (509)') < prompt.indexOf('the provider is wrong'),
    'the words come before the steering',
  );
});

/**
 * The vocabulary hands over identifiers, because that is what a codebase calls
 * itself. A real session came out as "Action_router leaks", which reads like a
 * stack trace rather than a name.
 */
test('an identifier is turned back into words', () => {
  assert.equal(tidyName('action_router leaks'), 'Action router leaks');
  assert.equal(tidyName('media_signals probe'), 'Media signals probe');
});

// ---------- the branch a person named --------------------------------------

const ran = (command: string): { type: string; input: unknown } => ({
  type: 'tool_use',
  input: { command, description: 'Bash' },
});

/**
 * The strongest signal, and the last one I looked for. The session that had to
 * be told twice it was about video models was working in
 * `fix/name-the-video-model-on-the-receipt` the whole time.
 */
test('branches: a person wrote these to describe the change', () => {
  const found = sessionBranches([
    ran('git checkout -b fix/name-the-video-model-on-the-receipt'),
    ran('git push origin fix/name-the-video-model-on-the-receipt'),
    ran('gh pr create --head feat/brand-invite-and-reset-mails'),
  ]);
  assert.equal(found[0], 'name the video model on the receipt', 'a ref becomes prose');
  assert.ok(found.includes('brand invite and reset mails'));
});

test('branches: the trunk names no work', () => {
  const found = sessionBranches([
    ran('git checkout -b main'),
    ran('git diff main...HEAD'),
    ran('git log origin/main..HEAD'),
    ran('git branch --show-current'),
  ]);
  assert.deepEqual(found, [], 'main, HEAD and a range are not a subject');
});

/** `agent-a019f08d365fbde8e` is named after the agent, and describes nothing. */
test('branches: an anonymous agent worktree is skipped', () => {
  const found = sessionBranches([
    ran('cd /repo/.claude/worktrees/agent-a019f08d365fbde8e && ls'),
    ran('cd /repo/.claude/worktrees/flux3-video && ls'),
  ]);
  assert.deepEqual(found, ['flux3 video']);
});

test('branches: the one worked in most comes first', () => {
  const found = sessionBranches([
    ran('git checkout -b probe/plate-preservation'),
    ran('git checkout -b fix/frontend-green'),
    ran('git commit -m x && git push origin fix/frontend-green'),
  ]);
  assert.equal(found[0], 'frontend green');
});

test('the prompt puts the branch above everything else', () => {
  const prompt = titlePrompt(
    [{ role: 'user', text: 'main must be green' }],
    [],
    ['model (28)'],
    ['name the video model on the receipt'],
  );
  assert.ok(
    prompt.indexOf('name the video model') < prompt.indexOf('model (28)'),
    'the branch is better evidence than the word counts',
  );
  assert.match(prompt, /best evidence/);
});

// ---------- the issue or PR in hand ----------------------------------------

/**
 * With ten tabs on ten pull requests the number finds the one you mean before
 * any wording does, and it is what you already have in your head when you go
 * looking. One real session mentioned its PR 335 times.
 */
test('issue: the one this session is actually about', () => {
  const events = [
    ...Array.from({ length: 8 }, () => ({ type: 'assistant_text', text: 'Reviewing PR 1226 again' })),
    { type: 'user_message', text: 'and #1190 is related but leave it' },
  ];
  assert.equal(sessionIssue(events), '#1226');
});

test('issue: a passing mention is not what the tab is about', () => {
  const events = [
    { type: 'assistant_text', text: 'this looks like #900' },
    { type: 'user_message', text: 'see also issue 901' },
  ];
  assert.equal(sessionIssue(events), '', 'twice between them is not a subject');
});

test('issue: read from prose as well as from commands', () => {
  const events = Array.from({ length: 6 }, () => ({
    type: 'tool_use',
    input: { command: 'gh pr view 1353 --json title' },
  }));
  assert.equal(sessionIssue(events), '#1353');
});

/**
 * Sharing one budget cost more than it looked: "#1354+ " is seven of twenty
 * characters, and "video continuation" came out as "Video". A number locates a
 * tab and describes nothing, so it rides outside the name's twenty.
 */
test('the number goes in front of the name, not into it', () => {
  assert.equal(
    composeTitle('blp', 'roaming chat history', '#1226+'),
    'blp|#1226+ roaming chat history',
  );
  assert.equal(composeTitle('blp', 'video continuation', '#1354'), 'blp|#1354 video continuation');
});

test('with no issue, the name has the whole budget', () => {
  assert.equal(composeTitle('blp', 'roaming chat history'), 'blp|roaming chat history');
});

/**
 * A real session swept five issues at once -- #808, #835, #759, #867, #751 --
 * and being labelled "#835" claimed something untrue about it. The plus costs
 * one character and says "and others", while still giving you a number to find
 * the tab by.
 */
test('issue: several in play is said, not silently narrowed to one', () => {
  const mention = (n: number, times: number) =>
    Array.from({ length: times }, () => ({ type: 'assistant_text', text: `looking at #${n}` }));
  const sweep = [...mention(808, 8), ...mention(835, 6), ...mention(759, 6), ...mention(867, 5)];
  assert.equal(sessionIssue(sweep), '#808+');
});

test('issue: one clearly the subject carries no plus', () => {
  const events = [
    ...Array.from({ length: 20 }, () => ({ type: 'assistant_text', text: 'PR 1226 again' })),
    ...Array.from({ length: 5 }, () => ({ type: 'assistant_text', text: 'and #1216' })),
  ];
  assert.equal(sessionIssue(events), '#1226', 'four times the runner-up is the subject');
});

/** An issue and its pull request are one thing wearing two words. */
test('issue: a number is the same number whether issue or PR', () => {
  const events = [
    ...Array.from({ length: 3 }, () => ({ type: 'assistant_text', text: 'issue 1354 says' })),
    ...Array.from({ length: 3 }, () => ({ type: 'tool_use', input: { command: 'gh pr view 1354' } })),
  ];
  assert.equal(sessionIssue(events), '#1354', 'six between them, one subject');
});

/**
 * `docs/` and `test/` are conventional-commit prefixes and also real
 * directories. Treating them as branch prefixes mined the repo for branches
 * called "api md" and "CURRENT STATE FRONTEND md".
 */
test('branches: a file is not a branch', () => {
  const found = sessionBranches([
    ran('cat docs/api.md'),
    ran('cat docs/ci-and-testing.md'),
    ran('sed -n 1,50p test/fixtures/thing.ts'),
    ran('git checkout -b fix/receipt-model.md'),
    ran('git checkout -b fix/receipt-model'),
    ran('git push origin fix/receipt-model'),
  ]);
  assert.deepEqual(found, ['receipt model']);
});

/**
 * Several issues at once usually means a run of bug fixes, and sometimes does
 * not -- so the namer is told, not made to obey. A rule would be wrong the
 * times it is wrong, and silently.
 */
test('several issues: the pattern is offered, not imposed', () => {
  const prompt = titlePrompt([{ role: 'user', text: 'fix these' }], [], [], [], '#808+');
  assert.match(prompt, /Several issues are in play \(#808 and others\)/);
  assert.match(prompt, /usually means a run of bug fixes/);
  assert.match(prompt, /not always/, 'the exception has to travel with the rule');
});

test('one issue says nothing about bug runs', () => {
  const prompt = titlePrompt([{ role: 'user', text: 'fix this' }], [], [], [], '#1345');
  assert.doesNotMatch(prompt, /Several issues/);
});

/**
 * Most re-namings are of a session that simply carried on. A tab you have
 * learned to recognise must not be reworded for the sake of it -- only a
 * subject that has actually become something else earns a new name.
 */
test('the namer is told what the tab is called now', () => {
  const prompt = titlePrompt(
    [{ role: 'user', text: 'carry on with the receipts' }],
    [],
    [],
    [],
    '',
    'blp|#1360+ Video model receipt',
  );
  assert.match(prompt, /currently called "blp\|#1360\+ Video model receipt"/);
  assert.match(prompt, /still about the same thing, reply with that name unchanged/);
  assert.match(prompt, /genuinely become something else/);
});

test('a first naming has no current name to keep', () => {
  const prompt = titlePrompt([{ role: 'user', text: 'start the receipts work' }]);
  assert.doesNotMatch(prompt, /currently called/);
});
