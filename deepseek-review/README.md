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
| `event` | `REQUEST_CHANGES` | Review event when the diff has findings. |
| `include-patterns` | _empty_ | Comma separated globs the review is restricted to. |
| `exclude-patterns` | lockfiles | Comma separated globs that are never reviewed. |
| `policy-file` | `.github/deepseek-review.md` | Review policy of the reviewed repository. |
| `policy-fallback-files` | `AGENTS.md,.github/copilot-instructions.md` | Read when the policy file is missing. Set to an empty string to disable. |
| `node-version` | `22` | Node.js version running the review. |
| `working-directory` | `.` | Directory the policy file is resolved from. |
| `mention` | `@deepseek-review` | Comment text that requests a new review. |
| `pr-number` | _empty_ | Pull request to review; empty uses the triggering event (pull request or `issue_comment`). |

## Behaviour

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
