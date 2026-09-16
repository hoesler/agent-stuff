# Access

Companion to SKILL.md. Establishing Azure DevOps access, then calling the REST API.

Nothing here is repository-specific — it applies to any Azure DevOps organization.

## The access contract

Azure DevOps access is not "find a token." It is a **tuple**, and every element must be resolved before the first API call:

| Element | Example |
|---|---|
| credential variable | `AZURE_DEVOPS_EXT_PAT` |
| auth scheme | Basic (PAT) **or** Bearer (Entra token) — never guessed |
| base URL | `$AZURE_DEVOPS_BASE_URL`, else `https://dev.azure.com` |
| routing identifiers | org, project, repo, branch — parsed from the git remote |

A partial tuple produces a **partial success that reads like a real one**: the request returns HTTP 200 and a body, but the body is a sign-in page or an anonymous identity. Resolve the whole tuple with the helper below, in one pass, before touching the PR.

## Step 1 — discover the routing identifiers

Pure git, no network:

```bash
SKILL_DIR=<directory containing this skill>   # e.g. ~/.agents/skills/azure-devops-pr
source "$SKILL_DIR/ado-access.sh"
ado_discover
```

Sets `ADO_ORG`, `ADO_PROJECT`, `ADO_REPO`, `ADO_BRANCH` from `git remote get-url origin` and the current branch.

| Remote format | Example | Parse |
|---|---|---|
| Modern HTTPS | `https://dev.azure.com/{org}/{project}/_git/{repo}` | path segments around `_git` |
| Legacy HTTPS | `https://{org}.visualstudio.com/{project}/_git/{repo}` | subdomain, then around `_git` |
| SSH | `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}` | colon-split path segments 1, 2, 3 |

A project name with a space stays percent-encoded (`My%20Project`) — that is correct in a URL path; do not decode it.

## Step 2 — resolve the credential and prove the identity

```bash
ado_resolve
```

`ado_resolve` picks the credential from an allowlist, **infers the auth scheme from the credential's shape**, sets the base URL, and probes `/_apis/connectionData`.

**Supported Azure DevOps credential variables — the complete list:**

`AZURE_DEVOPS_EXT_PAT`, `AZURE_DEVOPS_PAT`, `ADO_PAT`, `SYSTEM_ACCESSTOKEN`

### The two auth schemes are not interchangeable

| Credential shape | Scheme | Header |
|---|---|---|
| PAT (opaque string) | Basic, empty username | `Authorization: Basic base64(":" + PAT)` |
| Entra/AAD token (JWT, `eyJ…`) | Bearer | `Authorization: Bearer {jwt}` |

Sending a PAT as `Bearer` does not return 401 — it returns a **sign-in page with HTTP 200 or 203**. This is the single most common way an Azure DevOps session silently fails.

**`AZURE_BEARER_TOKEN` is not an Azure DevOps credential.** It is minted for the ARM audience (`https://management.azure.com`). dev.azure.com requires audience `499b84ac-1321-427f-aa17-267ca6975798`; the ARM token is rejected against it. **`NONO_PROXY_TOKEN` is not a credential either** — it is the sandbox proxy's own handle. Never `grep` the environment for "token" and treat a hit as a credential; the allowlist above is the only thing that counts.

If `ado_resolve` prints `STOP: no Azure DevOps credential in this session`, that is the final answer. Report that the profile injects no credential and stop. Do not run `az`, do not start a device-code flow, do not probe endpoints.

### Proxy-injected credentials

A nono profile may route `dev.azure.com` through a custom credential with `inject_mode: header`. The proxy then sets `Authorization` itself and the secret **never enters this process** — the env var named in the profile may be empty or absent here, and that is not a fault. `ado_resolve` detects the sandbox, sends no `Authorization` header of its own, and lets the identity probe decide. Sending your own header in this mode can conflict with the injected one.

Read the active profile to see the route rather than discovering it by trial and error:

```bash
python3 - <<'PY'
import json, os, re, glob
for f in glob.glob(os.path.expanduser("~/.config/nono/profiles/*.json")):
    txt = re.sub(r",(\s*[}\]])", r"\1", open(f).read())   # profiles may carry trailing commas
    try:
        p = json.loads(txt)
    except Exception as e:
        print(f, "UNPARSEABLE:", e); continue
    for name, c in (p.get("network", {}).get("custom_credentials") or {}).items():
        if "devops" in name or "dev.azure.com" in (c.get("upstream") or ""):
            print(f, name, c.get("upstream"), "| env:", c.get("env_var"),
                  "| mode:", c.get("inject_mode"), "| format:", c.get("credential_format"))
            for r in c.get("endpoint_rules", []):
                print("   ", r["method"], r["path"])
PY
```

An empty `endpoint_rules` list means every path on that host is permitted.

### Why `az` / `az repos` is not an option inside nono

The sandbox does not grant `~/.azure`, so the CLI dies before parsing any command:

```
PermissionError: [Errno 1] Operation not permitted: '/Users/you/.azure/azureProfile.json'
```

This is the OS-level sandbox, below the agent's permission layer, so no flag, retry, or `dangerouslyDisableSandbox` gets past it. Pointing `AZURE_CONFIG_DIR` at a writable directory makes `az` start against an empty profile with no credentials — also a dead end.

## Step 3 — the gate

**PR access is established only when a PR query actually returns JSON.**

```bash
ado_gate            # finds the active PR for ADO_BRANCH
ado_gate 1234       # or adopt a known PR id
```

Expected output:

```
PR lookup: OK (HTTP 200)
PR: 1234 | repo: kic-backend | project: KIC
```

Until this prints a PR id, do not read threads, do not implement changes, and do not draw conclusions about the review. If it fails, take the error to the decision table below — it names the one corrective action.

After the gate passes, `ado_api` is bound to the validated project and repo:

```bash
ado_api GET  "/git/repositories/$ADO_REPO/pullrequests/$ADO_PR_ID"
ado_pr                          # same thing
ado_threads                     # all comment threads
ado_reply <threadId> <parentCommentId> "Done — extracted into \`bar.py:42\`."
ado_thread_status <threadId> fixed
```

`ado_api` appends `api-version=7.0` unless the path already carries one, escapes JSON bodies through `json.dumps`, and classifies every response before printing it.

## The success that isn't

Azure DevOps answers unauthenticated requests with content, not with 401. Three responses all look like success to a naive `curl | jq`:

| What comes back | What it means |
|---|---|
| HTML body (`<!DOCTYPE html…`), HTTP 200 | Redirected to the sign-in page — no credential reached the API |
| HTTP 203 Non-Authoritative Information | Same thing, with the status ADO uses for API clients |
| JSON with `authenticatedUser.id` = all zeros, or display name `Anonymous` | The call was accepted **as nobody** |

`ado_resolve` fails on all three. A hand-rolled `curl` will not — it will hand you a page of HTML and a `jq` parse error that looks like a tooling bug. That misread is the reason this gate exists.

## Access-error decision table

Every access failure has exactly one corrective action. Take it; do not explore.

| Error | Interpretation | Next action |
|---|---|---|
| HTML sign-in page / HTTP 203 (`SignInPage`) | No usable credential reached the API, or a PAT was sent as Bearer | Return to `ado_resolve`. Do not change the URL, api-version, or headers |
| `Anonymous` identity on HTTP 200 | Request accepted as nobody | Same as above — the credential, not the request |
| `401 Unauthorized` | PAT expired or revoked | Ask the user for a fresh credential. Stop |
| `403` with `VS403403` / "does not have permission" | Credential is valid, PAT scope too narrow | Report the needed scope: `vso.code` to read, `vso.code_write` to reply or change thread status. Stop |
| `TF400813` / `TF401019` | Principal has no access to this project or repo | Report the missing access and scope. Stop |
| `GitRepositoryNotFoundException` on a path that looks right | Repo name wrong, or the project segment is missing from the base URL | Re-run `ado_discover`; the base must be `.../{org}/{project}/_apis/...`, never org-only |
| `400` naming the API version | `api-version` missing or unsupported on that route | Use `api-version=7.0`; let `ado_api` add it |
| Proxy `Forbidden` / no HTTP response at all | Route or endpoint rule does not permit this host or path | Read the profile's `endpoint_rules` (Step 2) and report the required route |
| `value: []` on the PR search | **Access works.** No active PR for that branch | Check the branch, the `refs/heads/` prefix, and `status=active`. Do not touch credentials |
| Thread list returns rows but none actionable | **Access works.** Filtering problem | Drop `isDeleted: true` threads and check `status`. Do not touch credentials |

The dividing line: the last two rows mean you are already inside the API and the problem is the query. Everything above them means the call never authenticated.

## Org-level vs project-level base URL

| Scope | Base | Used for |
|---|---|---|
| Organization | `https://dev.azure.com/{org}/_apis` | `connectionData`, `projects`, identity |
| Project | `https://dev.azure.com/{org}/{project}/_apis` | **everything about git, PRs, and threads** |

`ado_resolve` probes at org level; `ado_gate` and `ado_api` work at project level. Calling a git route against the org-level base is the second most common dead end after the auth scheme, and it fails as a confusing 404 rather than an auth error.

The repository identifier in a path can be the repo **name** (from the remote) or the GUID `id` returned in any PR response. Both work; the name is what `ado_discover` gives you.
