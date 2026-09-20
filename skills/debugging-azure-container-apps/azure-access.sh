#!/usr/bin/env bash
# Azure access resolver for Container Apps debugging.
#
#   source azure-access.sh
#   az_resolve                 # credential + base URL + ARM probe
#   az_workspaces              # discover workspace identifiers
#   az_gate <rg> <workspace-resource-name>   # 'print 1' probe; sets AZ_WS_*
#   query_log "<kql>"          # only usable after az_gate succeeds
#
# Every function prints a classified result and returns non-zero on failure.
# Do not improvise around a failure — look the error up in access.md.

# ---------------------------------------------------------------- credentials
# Allowlist. Anything not on this list is NOT an Azure credential, however
# token-like its name looks.
#
# Inside nono these variables usually do not hold a secret at all. nono runs a
# credential-injecting proxy and exports a PHANTOM token - the session token,
# the same bytes as $NONO_PROXY_TOKEN - under each loaded route env_var
# (nono crates/nono-proxy/src/server.rs:638). You send the phantom in the normal
# Authorization header; the proxy validates it, strips it, and substitutes the
# real credential upstream (reverse.rs:1899). Bearer is the right shape for a
# route with inject_mode=header, which is what the Azure routes use, so the
# Bearer header this file already sends is correct in both worlds.
#
# NONO_PROXY_TOKEN is deliberately absent, but not because it is junk: where a
# route has loaded, the allowlisted variable already equals it, and where no
# route has loaded, sending it only gets it forwarded to Azure and rejected.
AZ_CRED_VARS="AZURE_BEARER_TOKEN AZURE_MANAGEMENT_BEARER_TOKEN AZURE_ACCESS_TOKEN"

az__json() { python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }

# POST <url> <json-body> -> prints "<http-status>\n<body>"
az__post() {
  curl -s -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer $AZ_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$2" "$1"
}

az__REPORT_PY='
import json, os, sys
label = sys.argv[1]
raw = sys.stdin.read().rsplit("\n", 1)
body = raw[0]
status = (raw[1] if len(raw) > 1 else "").strip()
code = msg = hint = ""
sandbox = os.environ.get("AZ_SANDBOX") == "yes"
try:
    d = json.loads(body)
    e = d.get("error") or d.get("Error") or {}
    while isinstance(e, dict) and "error" in e:
        e = e["error"]
    if isinstance(e, dict) and e:
        code, msg = e.get("code", ""), e.get("message", "")
        for inner in (e.get("innererror"), e.get("details")):
            if inner:
                msg += " || " + json.dumps(inner)
    elif isinstance(e, str) and e:
        # Every Azure error is an object with a code. A bare {"error": "<string>"}
        # is an intermediary answering - in nono, the proxy rejecting the phantom
        # token before Azure ever saw the request (reverse.rs:2303 sends exactly
        # 401 {"error":"Unauthorized"}).
        code, msg = "ProxyRejected", e
        hint = ("not an Azure error payload - an intermediary answered, so the request never "
                "reached Azure")
        if sandbox:
            hint += (". That is the nono proxy rejecting the phantom token: the value of the "
                     "credential variable must go out as Authorization: Bearer <phantom> for a "
                     "route with inject_mode=header. Run az_nono_route. Do not touch the "
                     "credential and do not change the base URL")
except Exception:
    msg = body[:2000] if body.strip() else "<empty body>"
ok = status.startswith("2") and not code
print("%s: %s (HTTP %s)" % (label, "OK" if ok else "FAIL", status or "none - request never completed"))
if not ok:
    print("  code:    %s" % (code or "<none>"))
    print("  message: %s" % msg[:2000])
    if not hint and sandbox and code:
        # A real Azure error code proves the phantom validated and the proxy
        # forwarded the real credential. The route is not the suspect.
        hint = ("this IS an Azure error payload, so the phantom validated and the proxy "
                "forwarded the real credential - the fault is that credential or the request, "
                "not the route")
    if status in ("", "000"):
        hint = "no HTTP response - host blocked by sandbox network policy, or wrong base URL host"
    if hint:
        print("  hint:    %s" % hint)
sys.exit(0 if ok else 1)
'

az__report() {
  # stdin: response body followed by a trailing status line
  python3 -c "$az__REPORT_PY" "$1"
}

# Print the nono credential routes for the Azure hosts, when the active profile
# is readable. Diagnosis only - it never changes what az_resolve sends.
az_nono_route() {
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
        up = c.get("upstream") or ""
        if not any(h in up for h in ("management.azure.com", "loganalytics.io")):
            continue
        found = True
        print("route:           %s -> %s" % (name, up))
        print("  env_var:       %s   (holds the phantom, never a secret)" % c.get("env_var"))
        print("  inject_mode:   %s" % (c.get("inject_mode") or "header (default)"))
        print("  credential_key: %s   <- refresh THIS when the env_var is empty" % c.get("credential_key"))
sys.exit(0 if found else 1)
NONOPY
)
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
  else
    echo "  (no readable Azure route - ask which profile the session was started with)"
  fi
}

# ------------------------------------------------------------------- resolve
az_resolve() {
  AZ_RESOLVED=""
  AZ_SANDBOX=no
  [ -n "${NONO_CAP_FILE:-}" ] && AZ_SANDBOX=yes
  export AZ_SANDBOX        # az__report changes its hints inside the sandbox
  echo "Sandbox (NONO_CAP_FILE): $AZ_SANDBOX"

  AZ_TOKEN=""; AZ_TOKEN_VAR=""
  # Unquoted command substitution word-splits in both bash and zsh; a bare
  # "$AZ_CRED_VARS" would stay one word in zsh. Likewise ${!v} is bash-only,
  # so read the variable through eval. This file gets sourced into either shell.
  for v in $(echo "$AZ_CRED_VARS"); do
    eval "AZ_TOKEN=\${$v-}"
    if [ -n "$AZ_TOKEN" ]; then AZ_TOKEN_VAR="$v"; break; fi
  done

  if [ -z "$AZ_TOKEN" ] && [ "$AZ_SANDBOX" = no ]; then
    command -v az >/dev/null && AZ_TOKEN=$(az account get-access-token \
      --resource https://management.azure.com --query accessToken -o tsv 2>/dev/null)
    [ -n "$AZ_TOKEN" ] && AZ_TOKEN_VAR="az account get-access-token"
  fi

  if [ -z "$AZ_TOKEN" ]; then
    echo "STOP: no Azure credential in this session."
    echo "  Checked: $AZ_CRED_VARS"
    if [ "$AZ_SANDBOX" = yes ] && [ -n "${NONO_PROXY_TOKEN:-}" ]; then
      echo
      echo "  In a nono session an empty credential variable is a specific, fixable state,"
      echo "  not an absent route. nono exports a route phantom token only once that route"
      echo "  real credential has loaded (server.rs:630), so empty means the upstream secret"
      echo "  failed to load at proxy start. Usually it expired."
      echo
      echo "  Do NOT substitute \$NONO_PROXY_TOKEN by hand. With no loaded route there is"
      echo "  nothing to swap it for: the proxy forwards it and Azure rejects it with"
      echo "  401 InvalidTokenError, which reads like a dead token and is not one."
      echo
      echo "  Fix: refresh the secret named by the route credential_key, then restart the"
      echo "  nono session so the proxy reloads it. 'az_nono_route' names that secret."
    elif [ "$AZ_SANDBOX" = yes ]; then
      echo "  This nono profile injects no Azure credential. Report to the user; do not run 'az'."
    fi
    return 2
  fi
  if [ -n "${NONO_PROXY_TOKEN:-}" ] && [ "$AZ_TOKEN" = "$NONO_PROXY_TOKEN" ]; then
    echo "Credential:  \$$AZ_TOKEN_VAR — nono phantom token (byte-identical to \$NONO_PROXY_TOKEN)"
    echo "             sent as Bearer; the proxy validates it and swaps in the real credential."
  else
    echo "Credential:  \$$AZ_TOKEN_VAR"
  fi

  AZ_ARM="${AZURE_ARM_BASE_URL:-https://management.azure.com}"
  AZ_ARM="${AZ_ARM%/}"
  echo "ARM base:    $AZ_ARM"
  [ -n "${AZURE_LOG_ANALYTICS_BASE_URL:-}" ] &&
    echo "LA base:     ${AZURE_LOG_ANALYTICS_BASE_URL%/} (data plane; needs an LA-audience credential)"
  [ -n "${AZURE_LOG_ANALYTICS_BASE_URL:-}" ] && [ "$AZ_SANDBOX" = yes ] &&
    echo "             in nono the LA route usually shares the ARM route credential_key, so there is"
  [ -n "${AZURE_LOG_ANALYTICS_BASE_URL:-}" ] && [ "$AZ_SANDBOX" = yes ] &&
    echo "             no second variable to reach for - check with az_nono_route, then use Mode A."

  # ARM probe = Resource Graph. Do NOT probe with GET /subscriptions: sandbox
  # profiles routinely allow Resource Graph and per-resource-group reads while
  # denying the subscription list, so that probe fails on a working session.
  az__post "$AZ_ARM/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01" \
    '{"query":"resources | project id | limit 1"}' | az__report "ARM probe" || return 1
  AZ_RESOLVED=1
}

az__require_resolved() {
  if [ -z "${AZ_RESOLVED:-}" ]; then
    echo "az_resolve has not succeeded — nothing downstream can work. Fix that first (see access.md decision table)."
    return 2
  fi
}

# --------------------------------------------------------------- discovery
# Returns one row per managed environment: environmentName, customerId,
# workspaceResourceName, workspaceResourceGroup, workspaceResourceId.
az_workspaces() {
  az__require_resolved || return 2
  local q='resources
| where type =~ "microsoft.app/managedenvironments"
| extend customerId = tostring(properties.appLogsConfiguration.logAnalyticsConfiguration.customerId)
| join kind=leftouter (
    resources
    | where type =~ "microsoft.operationalinsights/workspaces"
    | extend customerId = tostring(properties.customerId)
    | project customerId, workspaceResourceName = name, workspaceResourceGroup = resourceGroup, workspaceResourceId = id
  ) on customerId
| project environmentName = name, environmentResourceGroup = resourceGroup, customerId, workspaceResourceName, workspaceResourceGroup, workspaceResourceId'
  az__post "$AZ_ARM/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01" \
    "{\"query\": $(printf '%s' "$q" | az__json)}" \
  | python3 -c '
import json,sys
raw = sys.stdin.read().rsplit("\n",1)[0]
d = json.loads(raw)
if "error" in d:
    print("ERROR:", json.dumps(d["error"])); sys.exit(1)
for row in d.get("data", []):
    print(json.dumps(row, indent=2))
'
}

# ------------------------------------------------------------------- the gate
# az_gate <workspaceResourceGroup> <workspaceResourceName> [subscription-id]
# Log-query access is not established until this prints OK.
az_gate() {
  az__require_resolved || return 2
  AZ_WS_RG="$1"; AZ_WS_NAME="$2"; AZ_SUB="${3:-${AZ_SUB:-}}"
  if [ -z "$AZ_WS_RG" ] || [ -z "$AZ_WS_NAME" ] || [ -z "$AZ_SUB" ]; then
    echo "usage: az_gate <workspaceResourceGroup> <workspaceResourceName> <subscription-id>"
    echo "  workspaceResourceName is a name like 'law-test-kic', never the customerId GUID."
    return 2
  fi
  # Casing matters: sandbox endpoint rules are written against 'resourceGroups'.
  AZ_WS_URL="$AZ_ARM/subscriptions/$AZ_SUB/resourceGroups/$AZ_WS_RG/providers/Microsoft.OperationalInsights/workspaces/$AZ_WS_NAME/api/query?api-version=2017-01-01-preview"
  az__post "$AZ_WS_URL" '{"query":"print AccessProbe = 1"}' | az__report "Log Analytics probe"
  local rc=$?
  [ $rc -eq 0 ] && echo "Mode: ARM workspace query | workspace: $AZ_WS_NAME | rg: $AZ_WS_RG"
  return $rc
}

# --------------------------------------------------------------- query helper
query_log() {
  if [ -z "${AZ_WS_URL:-}" ]; then echo "az_gate has not succeeded yet — run it first."; return 2; fi
  local out
  out=$(az__post "$AZ_WS_URL" "{\"query\": $(printf '%s' "$1" | az__json)}")
  printf '%s' "$out" | python3 -c '
import json,sys
raw = sys.stdin.read().rsplit("\n",1)
body, status = raw[0], (raw[1] if len(raw)>1 else "").strip()
try:
    d = json.loads(body)
except Exception:
    print("HTTP", status, body[:2000]); sys.exit(1)
if "error" in d:
    print("HTTP", status, "ERROR:", json.dumps(d["error"], indent=2)); sys.exit(1)
t = (d.get("Tables") or d.get("tables") or [{}])[0]
cols = [c.get("ColumnName") or c.get("name") for c in t.get("Columns", t.get("columns", []))]
if cols: print(" | ".join(cols))
rows = t.get("Rows", t.get("rows", []))
for r in rows:
    print(" | ".join(str(c)[:300] for c in r))
print(f"({len(rows)} rows)")
'
}
