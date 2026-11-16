# deepseek-review

DeepSeek based pull request review for the repositories of this organization.

It reviews the diff of a pull request and submits **one** pull request review with
`event: REQUEST_CHANGES` and **one inline comment per finding**, so every finding is a review thread that
has to be resolved before the pull request can be merged. A diff without findings is submitted as a
neutral `COMMENT` review, so a clean pull request is never blocked.

## Usage

Call the reusable workflow from the repository that should be reviewed:

```yaml
name: DeepSeek Code Review

on:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review]
  # Optional: lets a member request a new review by commenting on the pull request.
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  # The review state comment and the escalation label are issue side. Without it the
  # review still runs, only without its memory.
  issues: write

concurrency:
  # `cancel-in-progress` must only be true for pull request events. Every comment on the
  # pull request starts an `issue_comment` run in this group (the ClickUp integration, for
  # example, comments within seconds of a pull request being opened), and an unconditional
  # cancel would kill the review that is still starting up and then skip itself.
  group: deepseek-cr-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: ${{ github.event_name == 'pull_request_target' }}

jobs:
  code-review:
    uses: CodeEffect-GmbH/.github/.github/workflows/deepseek-review.yml@main
    permissions:
      contents: read
      pull-requests: write
      issues: write
    secrets:
      deepseek-api-key: ${{ secrets.DEEPSEEK_CODEREVIEW_API_KEY }}
    with:
      exclude-patterns: 'package-lock.json,**/package-lock.json,*.lock,**/*.lock'
```

The workflow can also be used as a single step (`uses: CodeEffect-GmbH/.github/deepseek-review@main`)
when a job needs its own steps around the review.

## Reviewing again on request

A review is triggered automatically by every push to the pull request. To review the same commit again -
for example after dismissing the review, or to ask for a second look at something specific - comment on
the pull request:

```
@deepseek-review please also check the migration order
```

- Only comments from `OWNER`, `MEMBER` and `COLLABORATOR` trigger a review (checked through
  `author_association`); bot comments are ignored, so no loop is possible. The allowed associations are
  fixed in the reusable workflow, not configurable per call.
- The comment text is passed to the model as a request for extra attention. It cannot override the review
  policy or the output contract.
- A requested review also runs on a draft pull request, because it is an explicit request; automatic runs
  still skip drafts until they are marked ready for review.
- The mention is configurable with the `mention` input of the reusable workflow, and the `issue_comment`
  trigger must be added by the calling repository.
- Every comment on a pull request starts a workflow run, including comments that do not mention the bot
  (an integration that links tasks, for example). Those runs are skipped in a few seconds and must not
  interrupt a review - see the `cancel-in-progress` condition in the snippet above.

## What the reviewed repository owns

Only the review policy: a markdown file that is sent as the repository specific part of the prompt.

1. Create `.github/deepseek-review.md` (or point `policy-file` somewhere else) and describe the
   architecture, the conventions and the rules the reviewer must enforce. Keep it short and in sync with
   the repository's own agent instructions.
2. When that file does not exist, the action falls back to `AGENTS.md` and
   `.github/copilot-instructions.md`, so a repository with instructions already in place works without
   any change.
3. Everything else (diff handling, line validation, review submission, dismissal of outdated bot
   reviews) is generic and lives here.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `deepseek-api-key` | - | **Required.** DeepSeek API token. |
| `model` | `deepseek-v4-flash` | DeepSeek model name. |
| `base-url` | `https://api.deepseek.com` | DeepSeek API endpoint. |
| `thinking` | `enabled` | Reasoning mode. `disabled` makes reviews much faster and shallower. |
| `thinking-max-chars` | `80000` | Diff size up to which reasoning is used. Above it the review runs without reasoning. |
| `max-diff-chars` | `200000` | Size of the diff one request may carry. A larger diff is reviewed in several requests that are merged into one review. |
| `max-batches` | `6` | Highest number of requests one run spends on a large diff. Files beyond it are reported as not reviewed. |
| `time-budget-minutes` | `20` | Wall clock budget of a run. When it is spent, no further part is requested; keep it below the job timeout. |
| `event` | `REQUEST_CHANGES` | Review event when a finding of a blocking severity exists. |
| `include-patterns` | _empty_ | Comma separated globs the review is restricted to. |
| `exclude-patterns` | lockfiles | Comma separated globs that are never reviewed. |
| `block-severities` | `BUG,SECURITY,BREAKING` | Severities that make the review request changes. Everything else is posted as a plain comment. |
| `ledger` | `on` | Remember settled findings in a sticky comment so a re-review converges. |
| `ignore-directive` | `/deepseek-ignore` | Phrase that settles a finding when it appears in a reply. |
| `breaker-label` | `ai-review:needs-decision` | Label added when the review stops converging. Empty disables it. |
| `temperature` | `0` | Temperature of the first request, so repeated runs agree. |
| `policy-file` | `.github/deepseek-review.md` | Review policy of the reviewed repository. |
| `policy-fallback-files` | `AGENTS.md,.github/copilot-instructions.md` | Read when the policy file is missing. Set to an empty string to disable. |
| `node-version` | `22` | Node.js version running the review. |
| `working-directory` | `.` | Directory the policy file is resolved from. |
| `mention` | `@deepseek-review` | Comment text that requests a new review. |
| `pr-number` | _empty_ | Pull request to review; empty uses the triggering event (pull request or `issue_comment`). |

## Blocking and clearing a change request

A review requests changes only when at least one finding has a severity from `block-severities`
(default `BUG,SECURITY,BREAKING`). Minor findings and suggestions are posted as ordinary comments and
never block a merge, because a review state is not something a thread resolution can clear.

GitHub keeps two independent gates, and they are easy to confuse:

- **Unresolved conversations** - the review threads. Resolving them satisfies
  "require conversation resolution".
- **A change request** - the state of the review itself. Resolving every thread does **not** clear it; it
  only ends when the same reviewer submits a new review that no longer requests changes, when it is
  dismissed, or when the pull request is approved by that reviewer.

That is why the review script dismisses its own earlier `CHANGES_REQUESTED` review on every run that does
not request changes. The state therefore follows the latest review, and a pull request is never blocked by
an outdated review. Two consequences:

- After fixing, push. The new run re-reviews, dismisses the old change request and either requests changes
  again or leaves a comment. No manual dismissal is needed.
- Without a new commit, ask for a review with the mention (`@deepseek-review`) to get the same effect,
  or use **Dismiss review** in the *Files changed* view of the pull request.

## Converging reviews

A review is only useful if it converges. A one-shot model opinion per push does not: it forgets what it
reported, it cannot see the replies, and it can end up asking for the opposite of what it asked for on the
previous commit. Four rules keep it monotone:

1. **The ledger.** One sticky comment per pull request records every finding with a fingerprint
   (path + normalized title) and its state: `open`, `answered`, `resolved` or `wontfix`. Each run reads it,
   reconciles it with the review threads (resolved threads and human replies are picked up automatically)
   and only reports findings it has never reported. A repeat is dropped and mentioned in the summary.
2. **Settled code does not block again.** A new finding whose hunk overlaps a settled finding is still
   reported, but never as a change request. It is posted as a comment and the run adds the
   `breaker-label`, because a review that keeps finding new problems on the same lines needs a human
   decision, not another round.
3. **Only added lines can block.** A finding on a context line - code this pull request did not write - is
   a comment. Combined with `block-severities` this keeps the change request for defects in the change
   itself.
4. **A won't-fix decision is final.** Reply on a thread with the ignore directive and a reason
   (`/deepseek-ignore by design, see ADR-7`) and the finding is recorded as `wontfix`: it is not raised
   again and the reason travels with every later run.

The previous findings and the replies are also sent to the model with an explicit contract - do not repeat
a settled finding, never ask for the reverse of a change that was already requested, and say so explicitly
if an earlier request turns out to be wrong. `temperature` is pinned on the first attempt so two runs on the
same diff do not disagree on principle.

The ledger needs `issues: write`. A caller that does not grant it still gets a review - it just has no
memory, which is the old behaviour.

## Behaviour

- Requests changes only for findings of a `block-severities` severity; every other finding is a comment.
- Reviews a diff larger than `thinking-max-chars` without reasoning. A reasoning model that spends its
  whole output budget on reasoning returns **no content at all**, which used to fail the job after three
  retries on big pull requests (~140k characters of diff); the same diff reviews fine without reasoning and
  in a fraction of the time.
- Degrades instead of failing when the answer is empty or the parameters are rejected: reasoning off, then
  half the diff, then a quarter without JSON mode. Every attempt is logged with the reason.
- Reviews a diff that does not fit one request in parts: the changed files are grouped into requests of at
  most `max-diff-chars` each (`max-batches` of them), every part is reviewed, and the findings of all parts
  are merged into one review. A part that fails does not lose the others; files left out are named in the
  review. Only a run in which every part fails is reported as failed.
- Stops starting new parts once `time-budget-minutes` is spent, so a huge diff is reviewed as far as the
  job timeout allows instead of being killed with nothing to show. Every request's own timeout is capped by
  the time that is left.
- Reads the review state defensively: the GraphQL connections (`{ nodes }`) and a plain list are both
  accepted, and an unreadable ledger or thread list costs the memory of the review, never the review.
- Skips automatic runs on drafts (a requested review reviews them) and pull requests whose title or body
  contains `skip cr` or `skip review`.
- Skips files without a text diff, removed files and everything matched by `exclude-patterns`.
- Annotates every diff line with its new-file line number, so findings can reference a line GitHub
  actually accepts; a finding with an unusable line is moved into the review body instead of failing.
- Dismisses the bot's own earlier `CHANGES_REQUESTED` reviews before submitting a new one, so an outdated
  review cannot keep blocking the pull request.
- Re-checks the head commit before posting, so a run overtaken by a new push submits nothing.
- Never checks out or executes pull request code: the diff is read as text from the API, and the review
  policy is read through the API at the base commit of the pull request, so a run needs no checkout at all.

## Requirements in the reviewed repository

- The branch protection must require a pull request review (and/or must require conversation
  resolution), otherwise `REQUEST_CHANGES` does not block a merge.
- The repository must grant this repository access to its actions when it is private
  (Settings -> Actions -> General -> Access).

## Development

```bash
node --test deepseek-review.test.mjs
```

The workflow runs the same command before each review, so a broken script fails the job instead of
posting a wrong review.
