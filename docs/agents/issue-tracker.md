# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `Giftia/OpenButler`. Use the `gh` CLI for issue and pull request operations when GitHub access is needed.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Run `gh` commands from inside the repo so the remote `OpenButler	https://github.com/Giftia/OpenButler.git` determines the GitHub repository.

## Pull requests as a triage surface

**PRs as a request surface: yes.**

External pull requests should run through the same triage labels and states as issues. Collaborator-owned in-flight PRs should not be treated as request intake unless the user explicitly asks.

Use the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, then keep only external associations such as `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label` / `--remove-label`, `gh pr close`

GitHub shares one number space across issues and PRs, so a bare `#42` may be either. Resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `Giftia/OpenButler`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`, or `gh pr view <number> --comments` when the ticket is a pull request.
