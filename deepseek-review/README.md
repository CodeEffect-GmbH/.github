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

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: deepseek-cr-${{ github.event.pull_request.number }}
  cancel-in-progress: true

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

## Behaviour

- Skips drafts (when called with `if: github.event.pull_request.draft == false`) and pull requests whose
  title or body contains `skip cr` or `skip review`.
- Skips files without a text diff, removed files and everything matched by `exclude-patterns`.
- Annotates every diff line with its new-file line number, so findings can reference a line GitHub
  actually accepts; a finding with an unusable line is moved into the review body instead of failing.
- Dismisses the bot's own earlier `CHANGES_REQUESTED` reviews before submitting a new one, so an outdated
  review cannot keep blocking the pull request.
- Re-checks the head commit before posting, so a run overtaken by a new push submits nothing.
- Never checks out or executes pull request code: only the diff text is read.

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
