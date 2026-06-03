# pi-review

`pi-review` adds a practical code review workflow to Pi via `/review` and `/end-review`.
Forked from https://github.com/earendil-works/pi-review.

## What It Does

- Review **uncommitted changes**
- Review changes against a **base branch**
- Review a specific **commit**
- Review a GitHub **pull request** (checks it out locally via `gh`)
- Review one or more **folders/files** as a snapshot (not a diff)
- Produce prioritized findings with a clear verdict and actionable follow-ups
- It separates feedback to the agent from human callouts

It also supports custom shared instructions that are loaded from `REVIEW_GUIDELINES.md`.

## Quick usage

```bash
/review
/review uncommitted
/review branch main
/review commit abc123
/review gh 123
/review gh https://github.com/owner/repo/pull/123
/review ado 123
/review ado https://dev.azure.com/owner/project/_git/repo/pullrequest/123
/review folder src docs
/review branch main --extra "focus on performance and error handling"
```

When a review session is active, finish it with:

```bash
/end-review
```

You can then return only, return + summarize, or return + queue fixing work.
