# Access

Companion to SKILL.md. Establishing Azure DevOps access, then calling the REST API.

Nothing here is repository-specific — it applies to any Azure DevOps organization.

## The access contract

Azure DevOps access is not "find a token." It is a **tuple**, and every element must be resolved before the first API call:

| Element | Example |
|---|---|
| credential variable | `AZURE_DEVOPS_EXT_PAT` |
| auth scheme | Basic (PAT) **or** Bearer (Entra token) — never guessed |
| base URL | `$AZURE_DEVOPS_BASE_URL`, else `https://dev.azure.com` — check what it holds; it may point at a proxy |
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

`ado_resolve` picks the credential from an allowlist, **infers the auth scheme from the credential's shape** (or recognises a nono [phantom token](#proxy-injected-credentials--the-phantom-token-pattern), whose scheme is fixed by the route), sets the base URL, and probes `/_apis/connectionData` at `api-version=7.0-preview` — that route is preview-only and rejects a bare `7.0`, while the git and PR routes below are served at `7.0`.

**Supported Azure DevOps credential variables — the complete list:**

`AZURE_DEVOPS_EXT_PAT`, `AZURE_DEVOPS_PAT`, `ADO_PAT`, `SYSTEM_ACCESSTOKEN`

### The two auth schemes are not interchangeable

| Credential shape | Scheme | Header |
|---|---|---|
| PAT (opaque string) | Basic, empty username | `Authorization: Basic base64(":" + PAT)` |
| Entra/AAD token (JWT, `eyJ…`) | Bearer | `Authorization: Bearer {jwt}` |

Sending a PAT as `Bearer` does not return 401 — it returns a **sign-in page with HTTP 200 or 203**. This is the single most common way an Azure DevOps session silently fails.

**`AZURE_BEARER_TOKEN` is not an Azure DevOps credential** — outside a sandbox. It is minted for the ARM audience (`https://management.azure.com`), and dev.azure.com requires audience `499b84ac-1321-427f-aa17-267ca6975798`. Never `grep` the environment for "token" and treat a hit as a credential; the allowlist above is the only thing that counts.

*Inside* nono that reasoning does not apply, because `$AZURE_BEARER_TOKEN` is not an ARM token there either — it is a phantom, byte-identical to every other route's phantom (see below). Nothing is gained by reaching for it: the allowlisted variable already holds the same bytes. The allowlist stands because it is the only rule that is right in **both** environments.

**`NONO_PROXY_TOKEN` is not on the list for a related reason.** It is never itself the thing to send. Where a route has loaded, the allowlisted variable already equals it; where no route has loaded, sending it does active harm. See below.

If `ado_resolve` prints `STOP: no Azure DevOps credential in this session`, stop and read the sandbox note it prints with it — in a nono session that message names a specific, fixable cause rather than an absent route. Do not run `az`, do not start a device-code flow, do not probe endpoints.

### Proxy-injected credentials — the phantom token pattern

Inside nono, **a credential variable does not hold a secret.** nono runs a credential-injecting proxy and uses the *phantom token* pattern. The mechanism, from the nono source:

| Step | Where |
|---|---|
| The session token is exported as `$NONO_PROXY_TOKEN` | `nono-proxy/src/server.rs:572` |
| Every **loaded** credential route exports *that same token again* under the route's `env_var` — the phantom | `server.rs:638` |
| You send the phantom in the service's ordinary auth header; the proxy compares it to the session token, **strips it**, and substitutes the real credential before forwarding | `reverse.rs:1899` |

So `$AZURE_DEVOPS_EXT_PAT` and `$NONO_PROXY_TOKEN` being byte-identical is not a coincidence to route around — it is the design, and it is how you recognise the mode:

```bash
[ -n "$AZURE_DEVOPS_EXT_PAT" ] && [ "$AZURE_DEVOPS_EXT_PAT" = "$NONO_PROXY_TOKEN" ] && echo "phantom"
```

**The phantom must be sent, not withheld.** Withholding it is the trap: there is no separate "the proxy sets `Authorization` itself" path. A missing header is `ProxyError::InvalidToken`, exactly like a wrong one.

**And it must be sent in the shape the route's `inject_mode` expects:**

| `inject_mode` | What the proxy accepts | Source |
|---|---|---|
| `header` (nono's default) | `<inject_header>: Bearer <phantom>` **or** a bare `<inject_header>: <phantom>` — validation strips one optional case-insensitive `Bearer ` and compares the rest | `reverse.rs:1909-1931` |
| `basic_auth` | `<inject_header>: Basic base64(user:<phantom>)`; the username is ignored, only the password is compared | `reverse.rs:1945` |

Within `header` mode the scheme genuinely does not matter — bare and `Bearer` are equivalent, so the client needs no knowledge of the route's `credential_format`. What does not carry over is the mode itself: no single shape satisfies both rows. `Basic base64(":" + phantom)` **fails** on a `header`-mode route, because the proxy compares the literal string `Basic OnBo…` against the session token. A PAT-shaped phantom invites exactly that mistake, and the resulting 401 reads like an expired PAT.

**The variable never holds a base64 `user:password` blob.** It is always the raw session token, byte-identical for every route in the session (`server.rs:638` pushes `self.token` verbatim). Where the real upstream credential *is* a `username:password` pair, the proxy encodes it on the far side (`credential.rs:91-95`) — that never enters this process, and it is not something to reconstruct here.

`ado_resolve` detects the phantom and sends `Authorization: Bearer <phantom>`, which is correct for `inject_mode: header` with `inject_header: Authorization`. It prints `nono phantom token` on the `Credential:` line when it does. Run `ado_nono_route` to see the route's actual settings.

#### Telling a proxy rejection from an Azure DevOps one

The proxy answers a failed validation with **401 and the body `{"error":"Unauthorized"}`** (`reverse.rs:2303`) — no `typeKey`, no `typeName`. That is the same bare-payload shape already in the decision table, and it is decisive:

- **Body carries `typeKey`/`typeName`** → the phantom validated, the proxy swapped in the real credential, and Azure DevOps itself answered. The route is not the problem, even on a 401.
- **Bare `{"error":"Unauthorized"}`** → the proxy rejected you. Azure DevOps never saw the request. Do not touch the credential or the base URL.

#### An empty credential variable means something specific

nono exports a route's phantom **only once that route's real credential has loaded** (`server.rs:630`). So in a nono session with a configured `dev.azure.com` route:

> **empty `$AZURE_DEVOPS_EXT_PAT` = the upstream secret failed to load at proxy start.**

It does *not* mean "no route" and it does *not* mean "the proxy will supply the credential". Usually the secret behind the route's `credential_key` expired.

Do **not** substitute `$NONO_PROXY_TOKEN` by hand here. With no loaded route there is nothing to swap it for; the proxy forwards it and Azure DevOps answers with a sign-in page — a failure that reads like a dead PAT and is not one.

The fix is to refresh the secret named by the route's `credential_key` and restart the nono session so the proxy reloads it:

```bash
ado_nono_route
```

```
route:           azure_devops -> https://dev.azure.com
env_var:         AZURE_DEVOPS_EXT_PAT   (holds the phantom, never a secret)
inject_mode:     header
inject_header:   Authorization
credential_key:  env://AZURE_ACCESS_TOKEN   <- refresh THIS when the env_var is empty
endpoint_rules:  every path permitted
```

An empty `endpoint_rules` list means every path on that host is permitted.

#### The proxy hop itself needs nothing from you

Separately from the phantom, the CONNECT hop is authenticated with `Proxy-Authorization`. nono sets `HTTP_PROXY=http://nono:<token>@127.0.0.1:<port>`, so curl and every other standard client send it automatically (`server.rs:533`), and the proxy strips it as hop-by-hop. There is nothing to configure, and `Proxy-Authorization` is never the cause of a 401 you can fix from the script.

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
| `401 Unauthorized` **from a `dev.azure.com` base** | PAT expired or revoked | Ask the user for a fresh credential. Stop |
| `401` whose body is not an Azure DevOps error (no `typeKey`/`typeName`, e.g. `{"error":"Unauthorized"}`) — **outside** a sandbox | An intermediary answered — the request never reached Azure DevOps | Check the base URL `ado_resolve` printed. Re-run with `AZURE_DEVOPS_BASE_URL=https://dev.azure.com`. Do not touch the credential |
| Same bare `401`, **inside** a sandbox (`ado_resolve` printed `Sandbox … yes`) | The nono proxy rejected the phantom token. Azure DevOps never saw the request | Confirm `ado_resolve` printed `nono phantom token`, then check the shape against the route's `inject_mode` (`ado_nono_route`). Do not touch the credential and do not change the base URL |
| Any error carrying `typeKey`/`typeName`, inside a sandbox | **The phantom validated** — the proxy swapped in the real credential and Azure DevOps answered | Read the row for that specific error. The route is not the problem |
| Empty credential variable in a nono session (`STOP` with the sandbox note) | The route's upstream secret failed to load at proxy start — usually expired | Refresh the secret named by the route's `credential_key` (`ado_nono_route`), then restart the nono session. Never hand-send `$NONO_PROXY_TOKEN` instead |
| `403` with `VS403403` / "does not have permission" | Credential is valid, PAT scope too narrow | Report the needed scope: `vso.code` to read, `vso.code_write` to reply or change thread status. Stop |
| `TF400813` / `TF401019` | Principal has no access to this project or repo | Report the missing access and scope. Stop |
| `GitRepositoryNotFoundException` on a path that looks right | Repo name wrong, or the project segment is missing from the base URL | Re-run `ado_discover`; the base must be `.../{org}/{project}/_apis/...`, never org-only |
| `400` naming the API version | `api-version` missing or unsupported on that route | Use `api-version=7.0`; let `ado_api` add it |
| `VssInvalidPreviewVersionException` ("the requested version … is under preview") | That route is preview-only; the version sent lacked `-preview` | Append `-preview` to that route's `api-version`. **Access works** — this is the request, not the credential |
| Proxy `Forbidden` / no HTTP response at all | Route or endpoint rule does not permit this host or path | Read the profile's `endpoint_rules` (Step 2) and report the required route |
| `value: []` on the PR search | **Access works.** No active PR for that branch | Check the branch, the `refs/heads/` prefix, and `status=active`. Do not touch credentials |
| Thread list returns rows but none actionable | **Access works.** Filtering problem | Drop `isDeleted: true` threads and check `status`. Do not touch credentials |

The dividing line: the last two rows mean you are already inside the API and the problem is the query. Everything above them means the call never authenticated.

## The base URL is part of the diagnosis

`ado_resolve` takes the base from `$AZURE_DEVOPS_BASE_URL` and falls back to `https://dev.azure.com`. In a sandbox that variable often points at a **local proxy** (`http://127.0.0.1:<port>/azure_devops`), and the port is regenerated per call — a base that changes between runs is the tell.

A proxy answers with its own errors. `{"error":"Unauthorized"}` and HTTP 401 is the proxy refusing the request; the PAT was never presented to Azure DevOps. Reading it as a dead credential sends you to "ask for a fresh credential, stop" while nothing is wrong with the credential at all.

A wrong base URL is one way to land there. **Inside a sandbox, a rejected phantom token is the more likely one**, and it needs the opposite fix — see [the phantom token pattern](#proxy-injected-credentials--the-phantom-token-pattern). Check `ado_resolve`'s `Sandbox` line before you reach for `AZURE_DEVOPS_BASE_URL`.

Two things separate the two cases:

- **The shape of the body.** Every Azure DevOps error carries `typeKey` or `typeName`. A bare `{"error": …}` did not come from Azure DevOps. `ado__report` says so in its hint and names the base it called.
- **The host.** `ado_resolve` prints `Base:` on every run and warns when it is not a `dev.azure.com` or `*.visualstudio.com` host.

When the base is not an Azure DevOps host, re-run the probe against the real one before drawing any conclusion about access:

```bash
AZURE_DEVOPS_BASE_URL=https://dev.azure.com
ado_resolve
```

This is the only base-URL change worth making. Everything else in the decision table still holds: do not go hunting through hosts, headers, or api-versions.

## Org-level vs project-level base URL

| Scope | Base | Used for |
|---|---|---|
| Organization | `https://dev.azure.com/{org}/_apis` | `connectionData`, `projects`, identity |
| Project | `https://dev.azure.com/{org}/{project}/_apis` | **everything about git, PRs, and threads** |

`ado_resolve` probes at org level; `ado_gate` and `ado_api` work at project level. Calling a git route against the org-level base is the second most common dead end after the auth scheme, and it fails as a confusing 404 rather than an auth error.

The repository identifier in a path can be the repo **name** (from the remote) or the GUID `id` returned in any PR response. Both work; the name is what `ado_discover` gives you.
