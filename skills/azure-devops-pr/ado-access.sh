#!/usr/bin/env bash
# Azure DevOps access resolver for PR work.
#
#   source ado-access.sh
#   ado_discover               # org/project/repo/branch from the git remote
#   ado_resolve                # credential + auth scheme + base URL + identity probe
#   ado_gate                   # find the active PR for this branch; sets ADO_PR_ID
#   ado_api GET "/git/repositories/$ADO_REPO/pullrequests/$ADO_PR_ID"
#
# Every function prints a classified result and returns non-zero on failure.
# Do not improvise around a failure — look the error up in access.md.

# ---------------------------------------------------------------- credentials
# Allowlist. Anything not on this list is NOT an Azure DevOps credential,
# however token-like its name looks.
#   *_PAT / *_TOKEN from this list  -> Basic auth (user "", password PAT)
#   SYSTEM_ACCESSTOKEN / a JWT      -> Bearer
# AZURE_BEARER_TOKEN is deliberately absent: outside a sandbox it is an
# ARM-audience token, and dev.azure.com needs audience
# 499b84ac-1321-427f-aa17-267ca6975798.
#
# NONO_PROXY_TOKEN is absent for a different reason: it is never itself the
# credential to send. Inside nono the variables above hold a PHANTOM equal to
# it, and ado__pick_cred recognises that. Reaching for NONO_PROXY_TOKEN
# directly only makes sense when a route loaded, in which case the allowlisted
# variable already holds the same bytes. See ado__pick_cred.
ADO_CRED_VARS="AZURE_DEVOPS_EXT_PAT AZURE_DEVOPS_PAT ADO_PAT SYSTEM_ACCESSTOKEN"

ado__json() { python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }

# ------------------------------------------------------------------ discovery
# Pure git, no network. Sets ADO_ORG, ADO_PROJECT, ADO_REPO, ADO_BRANCH.
ado_discover() {
  local url branch
  url=$(git remote get-url origin 2>/dev/null) || { echo "STOP: no git remote 'origin' here."; return 2; }
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

  eval "$(python3 - "$url" <<'PY'
import re, sys, urllib.parse
u = sys.argv[1].strip()
org = project = repo = ""
m = re.match(r"^git@ssh\.dev\.azure\.com:v3/([^/]+)/([^/]+)/(.+?)(?:\.git)?$", u)
if m:
    org, project, repo = m.groups()
else:
    if u.startswith("ssh://"):
        u = u.replace("ssh://git@ssh.dev.azure.com/v3/", "https://dev.azure.com/")
    p = urllib.parse.urlparse(u)
    host, segs = p.hostname or "", [s for s in p.path.split("/") if s]
    if segs and segs[-1].endswith(".git"):
        segs[-1] = segs[-1][:-4]
    if host.endswith("visualstudio.com"):          # legacy: {org}.visualstudio.com/{project}/_git/{repo}
        org = host.split(".")[0]
        if "_git" in segs:
            i = segs.index("_git"); project, repo = "/".join(segs[:i]) or "", segs[i+1] if len(segs) > i+1 else ""
    elif host.endswith("dev.azure.com"):           # modern: dev.azure.com/{org}/{project}/_git/{repo}
        if "_git" in segs:
            i = segs.index("_git"); org = segs[0] if segs else ""; project = "/".join(segs[1:i]); repo = segs[i+1] if len(segs) > i+1 else ""
        elif len(segs) >= 3:                       # ssh form rewritten above
            org, project, repo = segs[0], segs[1], segs[2]
q = lambda s: "'" + s.replace("'", "'\\''") + "'"
print("ADO_ORG=%s; ADO_PROJECT=%s; ADO_REPO=%s" % (q(org), q(project), q(repo)))
PY
)"
  ADO_BRANCH="$branch"

  if [ -z "$ADO_ORG" ] || [ -z "$ADO_PROJECT" ] || [ -z "$ADO_REPO" ]; then
    echo "STOP: '$url' does not parse as an Azure DevOps remote."
    echo "  Got org='$ADO_ORG' project='$ADO_PROJECT' repo='$ADO_REPO'"
    return 2
  fi
  echo "Org:         $ADO_ORG"
  echo "Project:     $ADO_PROJECT"
  echo "Repository:  $ADO_REPO"
  echo "Branch:      $ADO_BRANCH"
  ADO_DISCOVERED=1
}

# ------------------------------------------------------- credential selection
# Sets ADO_CRED, ADO_CRED_VAR, ADO_SCHEME, ADO_PHANTOM and ADO_AUTH_HEADER.
#
# Inside nono a credential variable does not hold a secret. nono runs a
# credential-injecting proxy and uses the PHANTOM TOKEN pattern
# (nono-proxy/README.md; crates/nono-proxy/src/server.rs):
#
#   * The session token is exported as $NONO_PROXY_TOKEN (server.rs:572).
#   * Each LOADED credential route exports that same token again under the
#     route's own env_var (server.rs:638) — so $AZURE_DEVOPS_EXT_PAT is
#     byte-for-byte $NONO_PROXY_TOKEN. That identity is the tell, not a fluke.
#   * You send the phantom in the service's normal auth header. The proxy
#     compares it to the session token, strips it, and substitutes the real
#     credential before forwarding (reverse.rs:1899).
#
# The env_var always holds the RAW session token — never a base64 user:password
# blob (server.rs:638 pushes self.token verbatim). Where the upstream credential
# really is a user:password pair, the proxy encodes it itself on the far side
# (credential.rs:91-95); that never reaches this process.
#
# So the phantom must be SENT, not withheld, and in the shape the route's
# inject_mode expects. Within inject_mode=header (nono's default, and this
# route's setting) the scheme does not matter: validation strips one optional
# case-insensitive "Bearer " and compares the rest, so `Bearer <phantom>` and a
# bare `<phantom>` are equivalent, while Basic fails (reverse.rs:1909-1931).
# inject_mode=basic_auth is the one that differs — it requires the literal
# "Basic " prefix and a colon in the decoded value, comparing only the password
# field (reverse.rs:1945, token.rs:349). No single shape satisfies both modes.
#
# A mismatched or missing header is ProxyError::InvalidToken, returned as 401
# with the body {"error":"Unauthorized"} (reverse.rs:2303). That body carries no
# typeKey/typeName, which is exactly how ado__report separates a proxy rejection
# from an Azure DevOps one.
ado__pick_cred() {
  local var val
  ADO_CRED=""; ADO_CRED_VAR=""; ADO_SCHEME=""; ADO_PHANTOM=no
  # Unquoted command substitution word-splits in both bash and zsh; a bare
  # "$ADO_CRED_VARS" would stay one word in zsh. Likewise ${!var} is bash-only,
  # so read the variable through eval. This file gets sourced into either shell.
  for var in $(echo "$ADO_CRED_VARS"); do
    eval "val=\${$var-}"
    [ -z "$val" ] && continue
    ADO_CRED_VAR="$var"; ADO_CRED="$val"
    break
  done

  if [ -n "$ADO_CRED" ] && [ -n "${NONO_PROXY_TOKEN:-}" ] &&
     [ "$ADO_CRED" = "$NONO_PROXY_TOKEN" ]; then
    ADO_PHANTOM=yes
    ADO_SCHEME=bearer
    ADO_AUTH_HEADER="Authorization: Bearer $ADO_CRED"
    echo "Credential:  \$$ADO_CRED_VAR — nono phantom token (byte-identical to \$NONO_PROXY_TOKEN)"
    echo "             sent as 'Authorization: Bearer <phantom>'; the proxy swaps in the real credential."
    return 0
  fi

  if [ -n "$ADO_CRED" ]; then
    # A real secret in this process. A JWT (three dot-separated base64url parts)
    # is an Entra token -> Bearer; anything else is a PAT -> Basic.
    case "$ADO_CRED" in
      eyJ*.*.*) ADO_SCHEME=bearer ;;
      *)        ADO_SCHEME=basic ;;
    esac
    if [ "$ADO_SCHEME" = basic ]; then
      ADO_AUTH_HEADER="Authorization: Basic $(printf ':%s' "$ADO_CRED" | base64 | tr -d '\n')"
    else
      ADO_AUTH_HEADER="Authorization: Bearer $ADO_CRED"
    fi
    echo "Credential:  \$$ADO_CRED_VAR (scheme: $ADO_SCHEME)"
    return 0
  fi

  echo "STOP: no Azure DevOps credential in this session."
  echo "  Checked: $ADO_CRED_VARS"
  if [ "${ADO_SANDBOX:-no}" = yes ] && [ -n "${NONO_PROXY_TOKEN:-}" ]; then
    echo
    echo "  An empty credential variable in a nono session is a specific, fixable state —"
    echo "  not a missing route. nono exports a route's phantom token only once that"
    echo "  route's real credential has loaded (server.rs:630), so empty means the"
    echo "  upstream secret failed to load at proxy start. Usually it expired."
    echo
    echo "  Do NOT substitute \$NONO_PROXY_TOKEN by hand. With no loaded route there is"
    echo "  nothing for the proxy to swap it for: it forwards the token and Azure DevOps"
    echo "  answers with a sign-in page, which reads like a dead PAT and is not one."
    echo
    echo "  Fix: refresh the secret named by the route's credential_key, then restart the"
    echo "  nono session so the proxy reloads it. 'ado_nono_route' names that secret."
  fi
  return 2
}

# Print the nono credential route for dev.azure.com, when the active profile is
# readable. Diagnosis only — it never changes what ado_resolve sends.
ado_nono_route() {
  local out
  out=$(python3 - <<'NONOPY'
import json, os, re, glob, sys
found = False
for f in sorted(glob.glob(os.path.expanduser("~/.config/nono/profiles/*.json"))):
    txt = re.sub(r",(\s*[}\]])", r"\1", open(f).read())   # profiles may carry trailing commas
    try:
        p = json.loads(txt)
    except Exception as e:
        print("%s UNPARSEABLE: %s" % (f, e)); continue
    for name, c in (p.get("network", {}).get("custom_credentials") or {}).items():
        if "devops" not in name and "dev.azure.com" not in (c.get("upstream") or ""):
            continue
        found = True
        print("profile:         %s" % os.path.basename(f))
        print("route:           %s -> %s" % (name, c.get("upstream")))
        print("env_var:         %s   (holds the phantom, never a secret)" % c.get("env_var"))
        print("inject_mode:     %s" % (c.get("inject_mode") or "header (default)"))
        print("inject_header:   %s" % (c.get("inject_header") or "Authorization (default)"))
        print("credential_key:  %s   <- refresh THIS when the env_var is empty" % c.get("credential_key"))
        rules = c.get("endpoint_rules") or []
        print("endpoint_rules:  %s" % ("every path permitted" if not rules else ""))
        for r in rules:
            print("                 %s %s" % (r.get("method"), r.get("path")))
sys.exit(0 if found else 1)
NONOPY
)
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
  else
    echo "  (no readable dev.azure.com route — ask which profile the session was started with)"
  fi
}

# -------------------------------------------------------------------- resolve
# Sets ADO_BASE and the ADO_AUTH_HEADER used by every later call.
ado_resolve() {
  ADO_RESOLVED=""
  ADO_AUTH_HEADER=""      # never inherit a header from an earlier run
  ADO_SANDBOX=no
  [ -n "${NONO_CAP_FILE:-}" ] && ADO_SANDBOX=yes
  export ADO_SANDBOX      # ado__report changes its hints inside the sandbox
  echo "Sandbox (NONO_CAP_FILE): $ADO_SANDBOX"

  if [ -z "${ADO_DISCOVERED:-}" ]; then
    echo "Run ado_discover first — the identity probe is org-scoped."
    return 2
  fi

  ado__pick_cred || return 2

  ADO_BASE="${AZURE_DEVOPS_BASE_URL:-https://dev.azure.com}"
  ADO_BASE="${ADO_BASE%/}"
  export ADO_BASE            # ado__report names it when an intermediary answers
  echo "Base:        $ADO_BASE"
  case "$ADO_BASE" in
    https://dev.azure.com|https://dev.azure.com/*|https://*.visualstudio.com|https://*.visualstudio.com/*) ;;
    *)
      echo "  WARNING: not an Azure DevOps host — this came from \$AZURE_DEVOPS_BASE_URL."
      echo "  Whatever sits there answers with its own errors. A 401 from it says nothing about the PAT."
      echo "  Before concluding anything about the credential, re-run with:"
      echo "    AZURE_DEVOPS_BASE_URL=https://dev.azure.com"
      ;;
  esac

  # Identity probe. connectionData is org-scoped, cheap, and — crucially —
  # answers 200 for anonymous callers too, so the check is WHO came back.
  # It is a preview-only route: orgs reject a bare "7.0" with
  # VssInvalidPreviewVersionException. The git/PR routes below are fine on 7.0.
  ado__curl GET "$ADO_BASE/$ADO_ORG/_apis/connectionData?api-version=7.0-preview" \
    | ado__report "Identity probe" --identity || return 1
  ADO_RESOLVED=1
}

ado__require_resolved() {
  if [ -z "${ADO_RESOLVED:-}" ]; then
    echo "ado_resolve has not succeeded — nothing downstream can work. Fix that first (see access.md decision table)."
    return 2
  fi
}

# ---------------------------------------------------------------- http + report
# ado__curl <method> <url> [json-body] -> prints "<body>\n<http-status>"
ado__curl() {
  local method="$1" url="$2" body="${3:-}"
  local args=(-s -w '\n%{http_code}' -X "$method" -H 'Accept: application/json')
  [ -n "${ADO_AUTH_HEADER:-}" ] && args+=(-H "$ADO_AUTH_HEADER")
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' -d "$body"); fi
  curl "${args[@]}" "$url"
}

ado__REPORT_PY='
import json, os, sys
label = sys.argv[1]
identity = "--identity" in sys.argv[2:]
raw = sys.stdin.read().rsplit("\n", 1)
body, status = raw[0], (raw[1] if len(raw) > 1 else "").strip()

def fail(code, msg, hint=None):
    print("%s: FAIL (HTTP %s)" % (label, status or "none - request never completed"))
    print("  code:    %s" % (code or "<none>"))
    print("  message: %s" % msg[:2000])
    if hint: print("  hint:    %s" % hint)
    sys.exit(1)

if status in ("", "000"):
    fail("", "<no response>", "host blocked by sandbox network policy, or wrong base URL host")

stripped = body.lstrip()
# The signature Azure DevOps failure: a sign-in PAGE, HTTP 200 or 203, not 401.
if stripped[:1] == "<" or "<!DOCTYPE html" in body[:400] or status == "203":
    fail("SignInPage",
         "Azure DevOps returned an HTML sign-in page instead of JSON.",
         "credential missing, expired, or sent with the wrong scheme - NOT a URL or api-version problem")

try:
    d = json.loads(body)
except Exception:
    fail("NonJson", body[:2000] or "<empty body>")

sandbox = os.environ.get("ADO_SANDBOX") == "yes"

if isinstance(d, dict) and (d.get("typeKey") or d.get("typeName") or not status.startswith("2")):
    key = d.get("typeKey") or d.get("errorCode") or status
    hint = None
    if not (d.get("typeKey") or d.get("typeName")):
        # Azure DevOps errors always carry typeKey/typeName. A bare {"error": ...}
        # came from something in front of the API, not from the API.
        hint = ("not an Azure DevOps error payload - an intermediary answered at %s, so the "
                "request never reached Azure DevOps"
                % (os.environ.get("ADO_BASE") or "the configured base URL"))
        hint += (". In the sandbox that intermediary is the nono proxy rejecting the phantom "
                 "token: the value of the credential variable has to be presented in the auth header of the route "
                 "- Bearer for inject_mode=header, Basic base64(user:phantom) for "
                 "basic_auth. Run ado_nono_route. Do not change the base URL or the credential"
                 if sandbox else
                 ". Fix the base URL before touching the credential")
    elif "PreviewVersion" in str(key):
        hint = ("that route is preview-only - append -preview to its api-version. "
                "Access is fine; this is the probe, not the credential")
    elif sandbox:
        # typeKey/typeName present = Azure DevOps itself answered, which proves
        # the phantom validated and the proxy already swapped in the real
        # credential. Keeps a 401 here from being misread as a routing problem.
        hint = ("this IS an Azure DevOps error payload, so the phantom validated and the proxy "
                "forwarded the real credential - the fault is that credential or the request, "
                "not the route. Refresh the secret named by credential_key on that route "
                "(ado_nono_route) rather than touching the phantom")
    fail(key, d.get("message") or json.dumps(d)[:2000], hint)

if identity:
    u = (d.get("authenticatedUser") or {})
    desc = u.get("subjectDescriptor") or ""
    name = u.get("providerDisplayName") or u.get("customDisplayName") or "<unknown>"
    anon = (u.get("id") == "00000000-0000-0000-0000-000000000000"
            or "Anonymous" in (u.get("providerDisplayName") or "")
            or not desc)
    if anon:
        fail("Anonymous",
             "Request succeeded but Azure DevOps authenticated nobody (identity: %s)." % name,
             "a 200 here does not mean access - in the sandbox this means no credential route "
             "matched, so the proxy forwarded the request unauthenticated (check the "
             "route upstream host with ado_nono_route); outside one, the local credential is dead. "
             "Either way: fix the credential, do not retry the URL" if sandbox else
             "a 200 here does not mean access - fix the credential, do not retry the URL")
    print("%s: OK (HTTP %s) - authenticated as %s" % (label, status, name))
    sys.exit(0)

print("%s: OK (HTTP %s)" % (label, status))
sys.exit(0)
'

ado__report() { python3 -c "$ado__REPORT_PY" "$@"; }

# ------------------------------------------------------------------- the gate
# PR access is established only when a PR query actually returns JSON.
# Sets ADO_PR_ID. Optional arg: an explicit PR id to adopt instead of searching.
ado_gate() {
  ado__require_resolved || return 2
  ADO_PROJ_BASE="$ADO_BASE/$ADO_ORG/$ADO_PROJECT/_apis"

  if [ -n "${1:-}" ]; then
    ADO_PR_ID="$1"
    ado_api GET "/git/repositories/$ADO_REPO/pullrequests/$ADO_PR_ID" >/dev/null || return 1
    echo "PR: $ADO_PR_ID (given) | repo: $ADO_REPO | project: $ADO_PROJECT"
    return 0
  fi

  local out
  out=$(ado__curl GET "$ADO_PROJ_BASE/git/repositories/$ADO_REPO/pullrequests?searchCriteria.sourceRefName=refs/heads/$ADO_BRANCH&searchCriteria.status=active&api-version=7.0")
  printf '%s' "$out" | ado__report "PR lookup" || return 1

  ADO_PR_ID=$(printf '%s' "$out" | python3 -c '
import json,sys
d = json.loads(sys.stdin.read().rsplit("\n",1)[0])
v = d.get("value") or []
print(v[0]["pullRequestId"] if v else "")
')
  if [ -z "$ADO_PR_ID" ]; then
    echo "No active PR for refs/heads/$ADO_BRANCH."
    echo "  Access works — this is an empty result, not a failure. Check the branch, or pass a PR id: ado_gate <prId>"
    return 1
  fi
  echo "PR: $ADO_PR_ID | repo: $ADO_REPO | project: $ADO_PROJECT"
}

# --------------------------------------------------------------- api helper
# ado_api <METHOD> <path-under-_apis> [json-body]
# Path is project-scoped and must start with '/', e.g. /git/repositories/...
# api-version=7.0 is appended unless the path already carries one.
ado_api() {
  if [ -z "${ADO_PROJ_BASE:-}" ]; then echo "ado_gate has not run yet — run it first."; return 2; fi
  local method="$1" path="$2" body="${3:-}" url sep
  case "$path" in /*) ;; *) echo "path must start with '/'"; return 2 ;; esac
  case "$path" in *api-version=*) url="$ADO_PROJ_BASE$path" ;;
    *) case "$path" in *\?*) sep='&' ;; *) sep='?' ;; esac
       url="$ADO_PROJ_BASE$path${sep}api-version=7.0" ;;
  esac
  local out rep
  out=$(ado__curl "$method" "$url" "$body")
  # Report once; on failure send the classification to stderr so it survives
  # a caller that redirects stdout.
  rep=$(printf '%s' "$out" | ado__report "$method $path") || {
    printf '%s\n' "$rep" >&2; return 1; }
  printf '%s' "$out" | python3 -c '
import json,sys
print(json.dumps(json.loads(sys.stdin.read().rsplit("\n",1)[0]), indent=2))
'
}

# ------------------------------------------------------------ thin wrappers
ado_pr()      { ado_api GET "/git/repositories/$ADO_REPO/pullrequests/$ADO_PR_ID"; }
ado_threads() { ado_api GET "/git/repositories/$ADO_REPO/pullrequests/$ADO_PR_ID/threads"; }

# ado_reply <threadId> <parentCommentId> <markdown>
ado_reply() {
  ado_api POST "/git/repositories/$ADO_REPO/pullrequests/$ADO_PR_ID/threads/$1/comments" \
    "{\"parentCommentId\": $2, \"content\": $(printf '%s' "$3" | ado__json)}"
}

# ado_thread_status <threadId> <active|fixed|wontFix|closed|byDesign|pending>
ado_thread_status() {
  ado_api PATCH "/git/repositories/$ADO_REPO/pullrequests/$ADO_PR_ID/threads/$1" \
    "{\"status\": \"$2\"}"
}
