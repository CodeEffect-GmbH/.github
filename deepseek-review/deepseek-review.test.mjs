import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  annotatePatch,
  buildDiffPayload,
  buildReviewBody,
  commentableLines,
  composeSystemPrompt,
  formatComment,
  loadPolicy,
  main,
  matchGlob,
  normalizeFindings,
  normalizePath,
  normalizeSeverity,
  parseHunks,
  parseModelOutput,
  resolvePath,
  selectChangedFiles,
  shouldSkip,
  snapToLine,
  splitPatterns,
} from './deepseek-review.mjs';

/**
 * Three old lines (10, 11, 12) and four new lines (10 .. 13). Line 11 is
 * rewritten, line 12 is new, so the right side can be commented on 10-13 and the
 * left side on 10-12.
 */
const SAMPLE_PATCH = [
  '@@ -10,3 +10,4 @@ export function foo() {',
  ' const context = 1;',
  '-const removed = 2;',
  '+const added = 2;',
  '+const addedToo = 3;',
  ' const tail = 4;',
  '\\ No newline at end of file',
].join('\n');

const SAMPLE_FILE = {
  path: 'api/src/foo.ts',
  filename: 'api/src/foo.ts',
  patch: SAMPLE_PATCH,
};

describe('path and pattern handling', () => {
  it('normalizes separators, prefixes and duplicate slashes', () => {
    assert.equal(normalizePath('.\\api\\\\src/foo.ts'), 'api/src/foo.ts');
    assert.equal(normalizePath('/timeoraapp/src/'), 'timeoraapp/src');
  });

  it('matches recursive, single segment and exact patterns', () => {
    assert.ok(matchGlob('timeoraapp/src/core/App.tsx', 'timeoraapp/src/**'));
    assert.ok(matchGlob('api/src/db/migrations/0012_x.sql', '**/*.sql'));
    assert.ok(matchGlob('package-lock.json', 'package-lock.json'));
    assert.ok(matchGlob('api/package-lock.json', '**/package-lock.json'));
    assert.ok(matchGlob('pnpm.lock', '*.lock'));
    assert.ok(!matchGlob('api/pnpm.lock', '*.lock'));
    assert.ok(!matchGlob('docsapp/RELEASENOTES.md', '*.md'));
  });

  it('splits comma and newline separated pattern lists', () => {
    assert.deepEqual(splitPatterns(' *.lock, package-lock.json \n**/*.zip '), [
      '*.lock',
      'package-lock.json',
      '**/*.zip',
    ]);
  });
});

describe('diff parsing', () => {
  it('maps every diff line onto its old and new line number', () => {
    const lines = commentableLines(SAMPLE_PATCH);
    assert.deepEqual([...lines.right], [10, 11, 12, 13]);
    assert.deepEqual([...lines.left], [10, 11, 12]);
  });

  it('keeps hunks apart so line numbers do not drift', () => {
    const patch = [
      '@@ -1,1 +1,2 @@',
      ' first',
      '+second',
      '@@ -40,1 +41,2 @@',
      ' forty',
      '+fortyone',
    ].join('\n');
    const hunks = parseHunks(patch);
    assert.equal(hunks.length, 2);
    assert.deepEqual([...commentableLines(patch).right], [1, 2, 41, 42]);
  });

  it('annotates a patch with the new file line numbers', () => {
    const { text } = annotatePatch('api/src/foo.ts', SAMPLE_PATCH);
    assert.match(text, /### File: api\/src\/foo\.ts/);
    assert.match(text, /^\s+11 \+const added = 2;$/m);
    assert.match(text, /^\s+-\s-const removed = 2;$/m);
  });

  it('truncates a file diff that exceeds its budget', () => {
    const { text, truncated } = annotatePatch('api/src/foo.ts', SAMPLE_PATCH, {
      maxChars: 20,
    });
    assert.ok(truncated);
    assert.match(text, /file diff was truncated/);
  });
});

describe('file selection', () => {
  const files = [
    { filename: 'api/src/a.ts', status: 'modified', patch: SAMPLE_PATCH },
    { filename: 'package-lock.json', status: 'modified', patch: SAMPLE_PATCH },
    { filename: 'assets/logo.png', status: 'added' },
    { filename: 'api/src/gone.ts', status: 'removed', patch: SAMPLE_PATCH },
  ];

  it('drops removed, binary and excluded files', () => {
    const { selected, skipped } = selectChangedFiles(
      files,
      [],
      ['package-lock.json'],
    );
    assert.deepEqual(
      selected.map((file) => file.path),
      ['api/src/a.ts'],
    );
    assert.deepEqual(
      skipped.map((entry) => entry.path),
      ['package-lock.json', 'assets/logo.png', 'api/src/gone.ts'],
    );
  });

  it('honours an include list when one is configured', () => {
    const { selected } = selectChangedFiles(files, ['timeoraapp/**'], []);
    assert.deepEqual(selected, []);
  });

  it('reports files that fell out of the character budget', () => {
    const files = [
      { path: 'api/src/a.ts', patch: SAMPLE_PATCH },
      { path: 'api/src/b.ts', patch: SAMPLE_PATCH },
    ];

    const full = buildDiffPayload(files, { maxDiffChars: 100_000 });
    assert.deepEqual(full.reviewed, ['api/src/a.ts', 'api/src/b.ts']);
    assert.deepEqual(full.omitted, []);
    assert.equal(full.truncated, false);

    const empty = buildDiffPayload(files, { maxDiffChars: 0 });
    assert.deepEqual(empty.reviewed, []);
    assert.deepEqual(empty.omitted, ['api/src/a.ts', 'api/src/b.ts']);
    assert.ok(empty.truncated);
  });
});

describe('finding normalization', () => {
  it('resolves paths the model shortened or prefixed', () => {
    const known = new Set(['api/src/crm/deals.ts']);
    assert.equal(
      resolvePath('api/src/crm/deals.ts', known),
      'api/src/crm/deals.ts',
    );
    assert.equal(
      resolvePath('b/api/src/crm/deals.ts', known),
      'api/src/crm/deals.ts',
    );
    assert.equal(resolvePath('deals.ts', known), 'api/src/crm/deals.ts');
    assert.equal(resolvePath('src/other.ts', known), null);
  });

  it('snaps an off-diff line onto the closest commentable line', () => {
    assert.equal(snapToLine(new Set([10, 11, 12, 13]), 99), 13);
    assert.equal(snapToLine(new Set([10, 11, 12, 13]), 11), 11);
    assert.equal(snapToLine(new Set(), 5), null);
  });

  it('maps severities onto the repository labels', () => {
    assert.equal(normalizeSeverity('critical'), 'BUG');
    assert.equal(normalizeSeverity('security'), 'SECURITY');
    assert.equal(normalizeSeverity('nit'), 'MINOR');
    assert.equal(normalizeSeverity(undefined), 'MINOR');
  });

  it('turns findings into comments GitHub accepts', () => {
    const { comments, demoted } = normalizeFindings(
      [
        {
          severity: 'MINOR',
          path: 'api/src/foo.ts',
          line: 13,
          title: 'Rename',
          body: 'Minor.',
        },
        {
          severity: 'bug',
          path: 'api/src/foo.ts',
          line: 99,
          title: 'Missing tenant scope',
          body: 'x',
        },
      ],
      [SAMPLE_FILE],
    );
    assert.equal(comments.length, 2);
    // Most severe first.
    assert.equal(comments[0].severity, 'BUG');
    assert.equal(comments[0].line, 13);
    assert.equal(comments[1].line, 13);
    assert.equal(demoted.length, 0);
  });

  it('uses the old side for comments about deleted code', () => {
    const { comments } = normalizeFindings(
      [
        {
          severity: 'BUG',
          path: 'api/src/foo.ts',
          line: 11,
          side: 'LEFT',
          title: 't',
          body: 'b',
        },
      ],
      [SAMPLE_FILE],
    );
    assert.equal(comments[0].side, 'LEFT');
    assert.equal(comments[0].line, 11);
  });

  it('demotes findings without a usable line or file instead of failing', () => {
    const { comments, demoted } = normalizeFindings(
      [
        {
          severity: 'BUG',
          path: 'api/src/unknown.ts',
          line: 3,
          title: 'Unknown file',
          body: 'b',
        },
        {
          severity: 'BUG',
          path: 'api/src/foo.ts',
          line: null,
          title: 'No line',
          body: 'b',
        },
      ],
      [SAMPLE_FILE],
    );
    assert.equal(comments.length, 0);
    assert.equal(demoted.length, 2);
    assert.match(demoted[0].reason, /unknown file/);
    assert.match(demoted[1].reason, /no commentable line/);
  });

  it('drops duplicates and keeps the finding limit', () => {
    const repeated = normalizeFindings(
      [
        {
          severity: 'BUG',
          path: 'api/src/foo.ts',
          line: 11,
          title: 'Same',
          body: 'x',
        },
        {
          severity: 'BUG',
          path: 'api/src/foo.ts',
          line: 11,
          title: 'Same',
          body: 'x',
        },
      ],
      [SAMPLE_FILE],
    );
    assert.equal(repeated.comments.length, 1);

    const limited = normalizeFindings(
      Array.from({ length: 4 }, (_, index) => ({
        severity: 'BUG',
        path: 'api/src/foo.ts',
        line: 11,
        title: `Finding ${index}`,
        body: 'x',
      })),
      [SAMPLE_FILE],
      { maxFindings: 2 },
    );
    assert.equal(limited.comments.length, 2);
    assert.equal(limited.demoted.length, 2);
  });

  it('formats a comment with severity and title', () => {
    assert.equal(
      formatComment({
        severity: 'BUG',
        title: 'Missing tenant scope',
        body: 'Scope it.',
      }),
      '**[BUG]** Missing tenant scope\n\nScope it.',
    );
  });
});

describe('model output parsing', () => {
  it('reads a fenced JSON answer', () => {
    const parsed = parseModelOutput(
      '```json\n{"summary":"ok","findings":[]}\n```',
    );
    assert.equal(parsed.unparsed, false);
    assert.equal(parsed.summary, 'ok');
    assert.deepEqual(parsed.findings, []);
  });

  it('reads JSON surrounded by prose and a bare findings array', () => {
    const parsed = parseModelOutput(
      'Here you go:\n{"summary":"s","findings":[{"title":"t"}]}\n',
    );
    assert.equal(parsed.findings.length, 1);
    assert.equal(parseModelOutput('[{"title":"t"}]').findings.length, 1);
  });

  it('falls back to prose so the answer is not lost', () => {
    const parsed = parseModelOutput('No real problems in this diff.');
    assert.equal(parsed.unparsed, true);
    assert.equal(parsed.summary, 'No real problems in this diff.');
    assert.deepEqual(parsed.findings, []);
  });
});

describe('review body', () => {
  const base = {
    pullRequest: { head: { sha: 'abcdef1234567' }, number: 1, title: 'Test' },
    payload: { reviewed: ['api/src/foo.ts'], omitted: [], truncated: false },
    usage: { total_tokens: 1234 },
    model: 'deepseek-v4-flash',
  };

  it('lists demoted findings and the reviewed commit', () => {
    const body = buildReviewBody({
      ...base,
      summary: 'One defect.',
      comments: [],
      demoted: [
        {
          severity: 'BUG',
          title: 'Could not place',
          body: 'Detail',
          reason: 'no line',
        },
      ],
    });
    assert.match(body, /1 finding/);
    assert.match(body, /Could not place/);
    assert.match(body, /commit abcdef1/);
  });

  it('never returns an empty body for a clean review', () => {
    const body = buildReviewBody({
      ...base,
      summary: '',
      comments: [],
      demoted: [],
    });
    assert.match(body, /no findings/);
  });
});

describe('skip marker', () => {
  it('recognizes the skip instructions in title and body', () => {
    assert.ok(shouldSkip({ title: 'Fix tenant scope [skip cr]' }));
    assert.ok(shouldSkip({ title: 'Fix', body: 'please skip review here' }));
    assert.ok(
      !shouldSkip({ title: 'Fix the review dialog', body: 'no marker' }),
    );
  });
});

/**
 * Runs the whole review flow against a stubbed `fetch` so the review payload
 * (event, commit, inline comments) can be asserted without network access.
 */
async function runReviewFlow(modelAnswer, options = {}) {
  const files = options.files ?? [SAMPLE_FILE];
  const title = options.title ?? 'Add deal forecast';
  const originalFetch = globalThis.fetch;
  const env = {
    GITHUB_REPOSITORY: 'CodeEffect-GmbH/io.timeora.app',
    PR_NUMBER: '7',
    GITHUB_TOKEN: 'test-token',
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_THINKING: 'enabled',
    REVIEW_EVENT: 'REQUEST_CHANGES',
    REVIEW_EXCLUDE_PATTERNS: 'package-lock.json,docsapp/RELEASENOTES.md',
    REVIEW_INCLUDE_PATTERNS: '',
    REVIEW_BLOCK_SEVERITIES: options.blockSeverities ?? 'BUG,SECURITY,BREAKING',
    REVIEW_POLICY_FILE: options.policyFile ?? 'missing-policy.md',
    REVIEW_POLICY_FALLBACK_FILES: '',
    REVIEW_SKIP_DRAFT: String(options.skipDraft ?? true),
    REVIEW_COMMENT: options.comment ?? '',
    GITHUB_STEP_SUMMARY: '',
  };
  const previousEnv = {};
  for (const [key, value] of Object.entries(env)) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }

  const calls = [];
  const pullRequest = {
    number: 7,
    title,
    body: '',
    draft: Boolean(options.draft),
    head: { sha: 'c0ffee1234567890' },
    base: { sha: 'base-sha-1234' },
  };

  globalThis.fetch = async (url, init = {}) => {
    const request = {
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(request);

    let payload = null;
    if (request.url.endsWith('/chat/completions')) {
      payload = {
        model: env.DEEPSEEK_MODEL,
        choices: [{ message: { content: modelAnswer } }],
        usage: { total_tokens: 42 },
      };
    } else if (
      request.method === 'GET' &&
      request.url.includes('/pulls/7/files')
    ) {
      payload = files;
    } else if (
      request.method === 'GET' &&
      request.url.includes('/pulls/7/reviews')
    ) {
      payload = options.reviews ?? [];
    } else if (
      request.method === 'GET' &&
      request.url.includes('/contents/')
    ) {
      const path = decodeURIComponent(
        request.url.split('/contents/')[1].split('?')[0],
      );
      const content = options.repoFiles?.[path];
      if (content === undefined) {
        return new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      payload = {
        path,
        encoding: 'base64',
        content: Buffer.from(content, 'utf8').toString('base64'),
      };
    } else if (request.method === 'GET' && request.url.endsWith('/pulls/7')) {
      payload = pullRequest;
    } else if (
      request.method === 'POST' &&
      request.url.endsWith('/pulls/7/reviews')
    ) {
      payload = { id: 99 };
    } else if (
      request.method === 'PUT' &&
      request.url.includes('/dismissals')
    ) {
      payload = { id: 98, state: 'DISMISSED' };
    } else {
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await main();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  return calls;
}

describe('review flow', () => {
  it('submits one REQUEST_CHANGES review with an inline comment per finding', async () => {
    const calls = await runReviewFlow(
      JSON.stringify({
        summary: 'One tenant scoping problem.',
        findings: [
          {
            severity: 'BUG',
            path: 'api/src/foo.ts',
            line: 86,
            title: 'Missing tenant filter',
            body: 'Scope it.',
          },
          {
            severity: 'MINOR',
            path: 'api/src/foo.ts',
            line: 1000,
            title: 'Naming',
            body: 'Rename it.',
          },
        ],
      }),
    );

    const completion = calls.find((call) =>
      call.url.endsWith('/chat/completions'),
    );
    assert.equal(completion.body.messages[0].role, 'system');
    assert.deepEqual(completion.body.thinking, { type: 'enabled' });
    assert.deepEqual(completion.body.response_format, { type: 'json_object' });
    assert.match(
      completion.body.messages[1].content,
      /^\s*11 \+const added = 2;$/m,
    );

    const posted = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/pulls/7/reviews'),
    );
    assert.equal(
      posted.url,
      'https://api.github.com/repos/CodeEffect-GmbH/io.timeora.app/pulls/7/reviews',
    );
    assert.equal(posted.body.event, 'REQUEST_CHANGES');
    assert.equal(posted.body.commit_id, 'c0ffee1234567890');
    assert.equal(posted.body.comments.length, 2);
    assert.deepEqual(posted.body.comments[0], {
      path: 'api/src/foo.ts',
      line: 13,
      side: 'RIGHT',
      body: '**[BUG]** Missing tenant filter\n\nScope it.',
    });
    assert.equal(posted.body.comments[1].line, 13);
    assert.match(posted.body.body, /2 findings/);
  });

  it('does not request changes when the diff has no findings', async () => {
    const calls = await runReviewFlow(
      JSON.stringify({ summary: 'No issues.', findings: [] }),
    );
    const posted = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/pulls/7/reviews'),
    );
    assert.equal(posted.body.event, 'COMMENT');
    assert.deepEqual(posted.body.comments, []);
  });

  it('skips the review when the title asks for it', async () => {
    const calls = await runReviewFlow(JSON.stringify({ findings: [] }), {
      title: 'Add forecast [skip cr]',
    });
    const reviewCall = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/pulls/7/reviews'),
    );
    assert.equal(reviewCall, undefined);
  });
});

describe('review policy', () => {
  it('appends the repository policy to the generic rules', () => {
    const prompt = composeSystemPrompt({
      policy: 'Always check tenant scoping.',
      policySource: '.github/deepseek-review.md',
    });
    assert.match(prompt, /Repository policy \(from \.github\/deepseek-review\.md\)/);
    assert.match(prompt, /Always check tenant scoping\./);
    assert.match(prompt, /Output contract/);
  });

  it('still produces a usable prompt without a policy', () => {
    const prompt = composeSystemPrompt({});
    assert.match(prompt, /How to review/);
    assert.match(prompt, /Output contract/);
    assert.doesNotMatch(prompt, /Repository policy/);
  });

  it('reads the policy file before the instruction file fallbacks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepseek-review-'));
    try {
      await writeFile(join(dir, 'AGENTS.md'), 'fallback rules', 'utf8');
      await writeFile(join(dir, 'policy.md'), 'policy rules', 'utf8');

      const fromPolicy = await loadPolicy(
        { policyFile: 'policy.md', policyFallbackFiles: ['AGENTS.md'] },
        { cwd: dir },
      );
      assert.equal(fromPolicy.policy, 'policy rules');
      assert.equal(fromPolicy.policySource, 'policy.md');

      const fromFallback = await loadPolicy(
        { policyFile: 'missing.md', policyFallbackFiles: ['AGENTS.md'] },
        { cwd: dir },
      );
      assert.equal(fromFallback.policy, 'fallback rules');
      assert.equal(fromFallback.policySource, 'AGENTS.md');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the generic rules when nothing is readable', async () => {
    const missing = await loadPolicy(
      { policyFile: 'a.md', policyFallbackFiles: ['b.md'] },
      { readFile: async () => { throw new Error('missing'); } },
    );
    assert.deepEqual(missing, { policy: '', policySource: '' });
  });

  it('sends the loaded policy as the system message of the review request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepseek-review-'));
    try {
      const policyFile = join(dir, 'policy.md');
      await writeFile(policyFile, 'POLICY-MARKER: scope every query by tenant.', 'utf8');

      const calls = await runReviewFlow(JSON.stringify({ findings: [] }), { policyFile });
      const completion = calls.find((call) => call.url.endsWith('/chat/completions'));
      assert.match(completion.body.messages[0].content, /POLICY-MARKER/);
      assert.match(completion.body.messages[0].content, /Output contract/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('review on request', () => {
  it('adds the requester note to the user message', async () => {
    const calls = await runReviewFlow(JSON.stringify({ findings: [] }), {
      comment: '@deepseek-review please also check the migration order',
    });
    const completion = calls.find((call) => call.url.endsWith('/chat/completions'));
    assert.match(
      completion.body.messages[1].content,
      /<comment>\n@deepseek-review please also check the migration order\n<\/comment>/,
    );
  });

  it('omits the note for a run that was not requested in a comment', async () => {
    const calls = await runReviewFlow(JSON.stringify({ findings: [] }));
    const completion = calls.find((call) => call.url.endsWith('/chat/completions'));
    assert.doesNotMatch(completion.body.messages[1].content, /<comment>/);
  });

  it('reviews a draft when the run was explicitly requested', async () => {
    const skipped = await runReviewFlow(JSON.stringify({ findings: [] }), {
      draft: true,
    });
    assert.equal(
      skipped.find((call) => call.method === 'POST' && call.url.endsWith('/pulls/7/reviews')),
      undefined,
    );

    const reviewed = await runReviewFlow(JSON.stringify({ findings: [] }), {
      draft: true,
      skipDraft: false,
      comment: '@deepseek-review',
    });
    assert.ok(
      reviewed.find((call) => call.method === 'POST' && call.url.endsWith('/pulls/7/reviews')),
    );
  });

  it('loads the review policy from the base commit when there is no checkout', async () => {
    const policyPath = 'nonexistent-dir/review-policy.md';
    const calls = await runReviewFlow(JSON.stringify({ findings: [] }), {
      policyFile: policyPath,
      repoFiles: { [policyPath]: 'API-POLICY: scope every query by tenant.' },
    });

    const contents = calls.find((call) => call.url.includes('/contents/'));
    assert.match(contents.url, /ref=base-sha-1234/);
    assert.match(contents.url, /nonexistent-dir\/review-policy\.md/);

    const completion = calls.find((call) => call.url.endsWith('/chat/completions'));
    assert.match(completion.body.messages[0].content, /API-POLICY/);
  });

  it('prefers the working tree policy over the repository copy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepseek-review-'));
    try {
      await writeFile(join(dir, 'policy.md'), 'local rules', 'utf8');
      const local = await loadPolicy(
        { policyFile: 'policy.md' },
        { cwd: dir, readFromRepo: async () => 'remote rules' },
      );
      assert.equal(local.policy, 'local rules');

      const remote = await loadPolicy(
        { policyFile: 'absent.md' },
        { cwd: dir, readFromRepo: async () => 'remote rules' },
      );
      assert.equal(remote.policy, 'remote rules');
      assert.equal(remote.policySource, 'absent.md');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('blocking severities', () => {
  const priorBlockingReview = {
    id: 501,
    state: 'CHANGES_REQUESTED',
    commit_id: 'older-commit',
    user: { login: 'github-actions[bot]', type: 'Bot' },
  };

  it('only comments on findings below the blocking severities', async () => {
    const calls = await runReviewFlow(
      JSON.stringify({
        summary: 'Nits only.',
        findings: [
          { severity: 'MINOR', path: 'api/src/foo.ts', line: 11, title: 'Rename', body: 'b' },
          { severity: 'PERFORMANCE', path: 'api/src/foo.ts', line: 12, title: 'Cache', body: 'b' },
        ],
      }),
      { reviews: [priorBlockingReview] },
    );

    const posted = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/pulls/7/reviews'),
    );
    assert.equal(posted.body.event, 'COMMENT');
    assert.equal(posted.body.comments.length, 2);
    assert.match(posted.body.body, /suggestions/);

    // The earlier change request must be dismissed, otherwise the pull request stays
    // blocked for a finding that no longer (or never) required a change.
    const dismissal = calls.find((call) => call.method === 'PUT');
    assert.equal(dismissal.url, 'https://api.github.com/repos/CodeEffect-GmbH/io.timeora.app/pulls/7/reviews/501/dismissals');
  });

  it('requests changes for a blocking severity', async () => {
    const calls = await runReviewFlow(
      JSON.stringify({
        findings: [
          { severity: 'MINOR', path: 'api/src/foo.ts', line: 11, title: 'Rename', body: 'b' },
          { severity: 'SECURITY', path: 'api/src/foo.ts', line: 12, title: 'Leak', body: 'b' },
        ],
      }),
      { reviews: [priorBlockingReview] },
    );

    const posted = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/pulls/7/reviews'),
    );
    assert.equal(posted.body.event, 'REQUEST_CHANGES');
    assert.doesNotMatch(posted.body.body, /suggestions/);
  });

  it('never requests changes when the blocking list is empty', async () => {
    const calls = await runReviewFlow(
      JSON.stringify({
        findings: [
          { severity: 'BUG', path: 'api/src/foo.ts', line: 11, title: 'Broken', body: 'b' },
        ],
      }),
      { blockSeverities: '' },
    );

    const posted = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/pulls/7/reviews'),
    );
    assert.equal(posted.body.event, 'COMMENT');
  });

  it('maps severity aliases onto the blocking list', async () => {
    const calls = await runReviewFlow(
      JSON.stringify({
        findings: [
          { severity: 'critical', path: 'api/src/foo.ts', line: 11, title: 'Broken', body: 'b' },
        ],
      }),
      { blockSeverities: 'bug' },
    );

    const posted = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/pulls/7/reviews'),
    );
    assert.equal(posted.body.event, 'REQUEST_CHANGES');
  });
});
