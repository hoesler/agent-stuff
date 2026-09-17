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
# AZURE_BEARER_TOKEN is deliberately absent: it is an ARM-audience token.
# dev.azure.com needs audience 499b84ac-1321-427f-aa17-267ca6975798.
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

# -------------------------------------------------------------------- resolve
# Sets ADO_BASE and the ADO_AUTH_HEADER used by every later call.
ado_resolve() {
  ADO_RESOLVED=""
  ADO_SANDBOX=no
  [ -n "${NONO_CAP_FILE:-}" ] && ADO_SANDBOX=yes
  echo "Sandbox (NONO_CAP_FILE): $ADO_SANDBOX"

  if [ -z "${ADO_DISCOVERED:-}" ]; then
    echo "Run ado_discover first — the identity probe is org-scoped."
    return 2
  fi

  local var val
  ADO_CRED=""; ADO_CRED_VAR=""; ADO_SCHEME=""
  # Unquoted command substitution word-splits in both bash and zsh; a bare
  # "$ADO_CRED_VARS" would stay one word in zsh. Likewise ${!var} is bash-only,
  # so read the variable through eval. This file gets sourced into either shell.
  for var in $(echo "$ADO_CRED_VARS"); do
    eval "val=\${$var-}"
    [ -z "$val" ] && continue
    ADO_CRED_VAR="$var"; ADO_CRED="$val"
    # A JWT (three dot-separated base64url parts) is an Entra token -> Bearer.
    case "$val" in
      eyJ*.*.*) ADO_SCHEME=bearer ;;
      *)        ADO_SCHEME=basic ;;
    esac
    break
  done

  if [ -n "$ADO_CRED" ]; then
    if [ "$ADO_SCHEME" = basic ]; then
      ADO_AUTH_HEADER="Authorization: Basic $(printf ':%s' "$ADO_CRED" | base64 | tr -d '\n')"
    else
      ADO_AUTH_HEADER="Authorization: Bearer $ADO_CRED"
    fi
    echo "Credential:  \$$ADO_CRED_VAR (scheme: $ADO_SCHEME)"
  elif [ "$ADO_SANDBOX" = yes ]; then
    # nono profiles route dev.azure.com through a custom credential with
    # inject_mode=header: the proxy sets Authorization itself and the value
    # never enters this process. Send none and let the probe decide.
    ADO_AUTH_HEADER=""
    echo "Credential:  none local — relying on sandbox proxy header injection"
  else
    echo "STOP: no Azure DevOps credential in this session."
    echo "  Checked: $ADO_CRED_VARS"
    echo "  AZURE_BEARER_TOKEN is an ARM token and must not be sent to dev.azure.com."
    echo "  NONO_PROXY_TOKEN is the sandbox's own handle, not a credential."
    return 2
  fi

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

if isinstance(d, dict) and (d.get("typeKey") or d.get("typeName") or not status.startswith("2")):
    key = d.get("typeKey") or d.get("errorCode") or status
    hint = None
    if not (d.get("typeKey") or d.get("typeName")):
        # Azure DevOps errors always carry typeKey/typeName. A bare {"error": ...}
        # came from something in front of the API, not from the API.
        hint = ("not an Azure DevOps error payload - an intermediary answered at %s. "
                "Fix the base URL before touching the credential"
                % (os.environ.get("ADO_BASE") or "the configured base URL"))
    elif "PreviewVersion" in str(key):
        hint = ("that route is preview-only - append -preview to its api-version. "
                "Access is fine; this is the probe, not the credential")
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
