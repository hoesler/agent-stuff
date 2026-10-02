# Creating a Pull Request

Companion to SKILL.md. Opens a PR that follows the repository's conventions: verify the branch, read the guidelines and template, show a pre-flight summary, create a **draft**, publish only on explicit approval.

Access comes first, exactly as for review work — the steps below assume `ado_discover` and `ado_resolve` passed ([access.md](access.md)).

"Just get it up", "I'm in a hurry" and similar are not approval to skip the pre-flight or to publish. A draft *is* up; the two stops (step 4 and step 7) cost one message each.

## 1. Make sure no PR exists yet

This is the `ado_gate` from SKILL.md step 0 — use its exit code if it already ran.

```bash
ado_gate
```

| Exit | Meaning | Next |
|---|---|---|
| `3` — `No active PR for refs/heads/…` | **Access works**, nothing open for this branch | Continue |
| `0` — prints a PR id | A PR already exists | Show `ado_web_url`, ask whether to update it instead. Do not create a second one |
| `1` / `2` | Access failure | [access.md](access.md) decision table |

## 2. Gather context

```bash
git status                          # uncommitted changes? ask: commit, stash, or leave out
TARGET=$(ado_default_branch)        # the repo's default branch, from Azure DevOps
[ -n "$TARGET" ] || echo "no target branch — stop and ask"
git fetch origin "$TARGET"          # compare against the real tip, not a stale tracking ref
git log "origin/$TARGET..HEAD" --oneline --no-decorate
git diff "origin/$TARGET..HEAD" --stat
```

- On the default branch itself → stop; ask the user to create or switch to a feature branch.
- No commits ahead → nothing to submit; ask whether they meant another branch.
- A different target (release branch, `develop`) is the user's call — ask if the branch name or commits suggest one.

From commits, branch name (`feature/1234-login-retry`) and the diff, infer:

1. **Work item(s)** — `#1234`, `AB#1234`, or a number in the branch name; pass just the number. None found → ask; "none" is a valid answer.
2. **What and why** — the problem solved, not a list of files.
3. **Type of change** — fix, feature, breaking change, refactor, docs, build/CI.
4. **How it was tested** — and what could break.

Ask only for what cannot be inferred.

## 3. Read the conventions

**Contribution guidelines:**

```bash
ls CONTRIBUTING* docs/CONTRIBUTING* .azuredevops/CONTRIBUTING* 2>/dev/null
```

Also scan `README.md` for a contributing section. Apply title formats, mandatory sections and sign-offs, and **extract every checklist item** ("run tests", "update CHANGELOG", …) for the pre-flight summary.

**PR template.** Azure DevOps looks in `/.azuredevops/`, `/.vsts/`, `/docs/`, then the repo root, for `pull_request_template.md` (or `.txt`, case-insensitive):

```bash
find .azuredevops .vsts docs . -maxdepth 3 -ipath '*pull_request_template*' -not -path './.git/*' 2>/dev/null
```

This lists the default file and the `pull_request_template/` folder contents, including `branches/<target>.md`.

| Found | Use |
|---|---|
| `pull_request_template/branches/<target>.md` in any of those folders | This one — a branch-specific template beats the default |
| `pull_request_template.md` | This one — the repo's default |
| `pull_request_template/*.md` only | Optional templates; ask which applies |
| Only `.github/pull_request_template.md` | Not read by Azure DevOps, but it is the repo's convention — use it |
| Nothing | The [default template](#default-template) below |

**The REST API does not apply templates** — only the web UI does. You fill it in yourself: match its structure exactly, fill every section, tick the applicable type and checklist boxes.

### Default template

Use it only when the repository has none. Every heading stays; a section with nothing to say gets "None", never silence.

```markdown
## Problem
Why this change? The problem or need, in the reader's terms — not a list of files.

## Solution
How it solves the problem: the approach, and why this one over the obvious alternative.

## Testing
What a reviewer or tester should check by hand that the automated tests do not cover.

## Breaking changes
What breaks for whom, and the migration step. "None" if nothing.

## Review focus
Where to look closely: the risky, subtle or least certain parts, with file paths.

## Links
Work items (#1234), related PRs, docs, discussions.
```

The description is capped at **4000 characters**. `ado_create_pr` refuses longer text; shorten prose, never drop template sections.

## 4. Pre-flight summary — then wait

> **Ready to open a draft PR — here's what I checked:**
>
> - **Branch:** `feature/1234-login-retry` → `main` (not pushed yet — I'll push on your OK)
> - **Commits:** 3 ahead of `main`
> - **Contribution guidelines:** Found in `CONTRIBUTING.md`
>   - ✅ Run `npm test` — done
>   - ❌ Update CHANGELOG — not done
>   - ❓ Lint clean — not verified
>   *(every extracted item, none omitted)*
> - **PR template:** `.azuredevops/pull_request_template.md` / None — using the default
> - **Work items:** #1234 / None
>
> **Proposed PR:** "feat: retry login on transient failures" · Feature
>
> Shall I open this as a draft PR?

For each ❓ item, offer to run it; for each ❌ item, offer to do it (e.g. add the CHANGELOG entry) or note it as open in the description. Wait for the answer before pushing or creating anything.

## 5. Push and verify

```bash
git push -u origin HEAD             # --force-with-lease only after a rebase you were asked to do
ado_branch_pushed                   # remote ref must equal local HEAD
```

`ado_branch_pushed` asks Azure DevOps, not git, so it is right even where git has no credential. Push only after the pre-flight is confirmed — it is the first thing other people can see. Creating a PR from an unpushed branch fails with `TF401398`.

Inside a sandbox, `git push` may have no credential even though the REST helpers work — those go through a proxy route, git does not. If the push fails there, ask the user to push from the host; do not try to craft a git credential from the phantom token.

## 6. Create as draft

Write the description to a file — titles and markdown with quotes and newlines are escaped by the helper, not by you:

```bash
DESC=$(mktemp)
# write the filled-in template to "$DESC"
ado_create_pr "$TARGET" "feat: retry login on transient failures" "$DESC" 1234
rm "$DESC"
```

Every trailing argument is a work item id, linked via `workItemRefs`. The helper always sets `isDraft: true`, sets `ADO_PR_ID`, and prints the **web** link — the `url` field in the API response is a REST link, not a page.

Branch policies apply on their own: required reviewers are added automatically, and a "linked work items" policy blocks completion, not creation.

## 7. Review, then publish

> The draft PR is ready: <link>
> Please review it in Azure DevOps. Shall I publish it, or would you like changes first?

Only on explicit confirmation:

```bash
ado_publish_pr                      # isDraft -> false
```

Changes requested instead → `ado_api PATCH "/git/repositories/$ADO_REPO/pullrequests/$ADO_PR_ID" "$JSON"` with a `title` and/or `description`; build `$JSON` with `python3 -c 'import json…'`, since `ado_api` sends its body verbatim.

## Errors specific to creation

| Error | Meaning | Next |
|---|---|---|
| `TF401398` source branch not found | Branch not pushed | Step 5 |
| `TF401179` an active PR already exists | Someone opened it in the meantime | Back to step 1 |
| `403` / `VS403403` on POST | Credential can read but not write | Report scope `vso.code_write`. Stop |
| `403` naming work items | Credential cannot link work items | Report it; offer to create without the link and add it in the UI |
| `description is … chars` (local) | Over the 4000-character cap | Shorten, keep every template section |
