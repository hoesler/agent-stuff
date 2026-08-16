# Access and Querying

Companion to SKILL.md. Establishing Azure access, then querying Log Analytics and inspecting resources.

Nothing here is workload-specific — it applies to any Azure Container App or Container App Job.

## The access contract

Azure access is not "find a token." It is a **tuple**, and every element must be resolved before the first query:

| Element | Example |
|---|---|
| credential variable | `AZURE_BEARER_TOKEN` |
| base URL | `$AZURE_ARM_BASE_URL`, else `https://management.azure.com` |
| query mode | ARM workspace query **or** Log Analytics data plane — never mixed |
| workspace identifier | `workspaceResourceName` for ARM, `customerId` GUID for data plane |

A partial tuple produces a partial success: ARM answers, Log Analytics returns `InvalidTokenError`, and the session degenerates into guessing endpoints. **Resolve the whole tuple with the helper below, in one pass, before any diagnosis.**

## Step 1 — run the resolver

```bash
SKILL_DIR=<directory containing this skill>   # e.g. ~/.agents/skills/debugging-azure-container-apps
source "$SKILL_DIR/azure-access.sh"
az_resolve
```

`az_resolve` detects the sandbox, picks the credential from an allowlist, sets the ARM base URL, and probes ARM via Resource Graph. It prints HTTP status, Azure error code and message on failure.

**Supported Azure credential variables — the complete list:**

`AZURE_BEARER_TOKEN`, `AZURE_MANAGEMENT_BEARER_TOKEN`, `AZURE_ACCESS_TOKEN`

**`NONO_PROXY_TOKEN` is not an Azure credential.** It is the sandbox proxy's own handle. Sending it to Azure yields `401 InvalidTokenError`. Never `grep` the environment for "token" and treat a hit as an Azure credential — the allowlist above is the only thing that counts.

If `az_resolve` prints `STOP: no Azure credential in this session`, that is the final answer for this session. Report to the user that the nono profile injects no Azure credential and stop. Do not run `az`, do not start a device-code flow, do not probe endpoints.

### Why `az` is not an option inside nono

The sandbox does not grant `~/.azure`, so the CLI dies before parsing any command:

```
PermissionError: [Errno 1] Operation not permitted: '/Users/you/.azure/azureProfile.json'
```

This is the OS-level sandbox, below the agent's permission layer, so no flag, retry, or `dangerouslyDisableSandbox` gets past it. Pointing `AZURE_CONFIG_DIR` at a writable directory makes `az` start against an empty profile with no credentials — also a dead end.

Outside a sandbox (`NONO_CAP_FILE` unset) `az_resolve` falls back to `az account get-access-token` automatically.

### What the sandbox profile grants

Credential routes and their per-resource-group endpoint allow-lists live in the active nono profile, which is readable:

```bash
python3 - <<'PY'
import json, os, re, glob
cap = json.load(open(os.environ["NONO_CAP_FILE"]))
print("allowed domains:", [d for d in cap["allowed_domains"]
                          if "azure" in d or "loganalytics" in d])
for f in glob.glob(os.path.expanduser("~/.config/nono/profiles/*.json")):
    txt = re.sub(r",(\s*[}\]])", r"\1", open(f).read())   # profiles may carry trailing commas
    try:
        p = json.loads(txt)
    except Exception as e:
        print(f, "UNPARSEABLE:", e); continue
    for name, c in (p.get("network", {}).get("custom_credentials") or {}).items():
        if "azure" in name:
            print(f, name, c.get("upstream"), "env:", c.get("env_var"))
            for r in c.get("endpoint_rules", []):
                print("   ", r["method"], r["path"])
PY
```

This is the authoritative answer to "which subscriptions, resource groups and paths can I reach" — read it instead of discovering the boundary by trial and error. Path matching is case-sensitive: the rules are written with `resourceGroups`, so use that casing (not `resourcegroups`) in every URL.

## Step 2 — resolve workspace identifiers

Four different values get called "the workspace." Confusing them is the single most common dead end.

| Value | Looks like | Used by |
|---|---|---|
| `workspaceResourceName` | `law-test-kic` | ARM workspace query path |
| `workspaceResourceGroup` | `rg-kic-infrastructure-test` | ARM workspace query path |
| `customerId` | GUID | Log Analytics **data plane** path only |
| `workspaceResourceId` | `/subscriptions/.../workspaces/law-test-kic` | ARM metadata, joins |

The managed environment only carries the **`customerId` GUID**. Putting that GUID into an ARM resource path returns `ResourceNotFound`. Resolve the resource name by joining to the workspace resource:

```bash
az_workspaces
```

which runs:

```kql
resources
| where type =~ "microsoft.app/managedenvironments"
| extend customerId = tostring(properties.appLogsConfiguration.logAnalyticsConfiguration.customerId)
| join kind=leftouter (
    resources
    | where type =~ "microsoft.operationalinsights/workspaces"
    | extend customerId = tostring(properties.customerId)
    | project customerId, workspaceResourceName = name,
              workspaceResourceGroup = resourceGroup, workspaceResourceId = id
  ) on customerId
| project environmentName = name, environmentResourceGroup = resourceGroup,
          customerId, workspaceResourceName, workspaceResourceGroup, workspaceResourceId
```

If `workspaceResourceName` comes back empty, the workspace lives outside the scope this session can read — say so rather than falling back to the GUID.

## Step 3 — the gate

**Log-query access is established only when a query actually runs.** An ARM call succeeding proves nothing about Log Analytics: different audience, different path, often a different endpoint rule.

```bash
az_gate <workspaceResourceGroup> <workspaceResourceName> <subscription-id>
```

Expected output:

```
Log Analytics probe: OK (HTTP 200)
Mode: ARM workspace query | workspace: law-test-kic | rg: rg-kic-infrastructure-test
```

Until this prints OK, do not query tables, do not write KQL, and do not draw conclusions about the application. If it fails, take the error to the decision table below — it names the one corrective action.

After the gate passes, `query_log` is bound to the validated workspace:

```bash
query_log "
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == '<app-name>'
| take 10
"
```

## The two query modes — never mix them

### Mode A: ARM workspace query (default; use this)

```
Base:        ARM base URL ($AZURE_ARM_BASE_URL or https://management.azure.com)
Credential:  ARM-audience credential (the one az_resolve selected)
Identifier:  workspaceResourceName
Path:        /subscriptions/{sub}/resourceGroups/{rg}/providers/
             Microsoft.OperationalInsights/workspaces/{workspaceResourceName}/api/query
             ?api-version=2017-01-01-preview
```

### Mode B: Log Analytics data plane

```
Base:        https://api.loganalytics.io (or $AZURE_LOG_ANALYTICS_BASE_URL)
Credential:  a credential minted for the Log Analytics audience — NOT the ARM one
Identifier:  customerId GUID
Path:        /v1/workspaces/{customerId}/query
```

Mode B needs its own audience. In a sandbox the injected credential is usually ARM-audience only, so Mode B returns `InvalidTokenError` / `SignatureVerificationFailed` no matter what you do to the URL. **Use Mode A unless the profile shows a distinct Log Analytics credential.**

Components are not interchangeable. An ARM resource path appended to a data-plane base URL, or a `customerId` in an ARM path, is always wrong — no api-version, header, or `listKeys` call rescues it.

## Access-error decision table

Every access failure has exactly one corrective action. Take it; do not explore.

| Error | Interpretation | Next action |
|---|---|---|
| `InvalidTokenError`, `SignatureVerificationFailed`, `InvalidAuthenticationToken` | Wrong audience for the endpoint, or a proxy token sent as an Azure token | Return to `az_resolve` and use Mode A. Do not change KQL, api-version, or headers |
| `401` from `api.loganalytics.io` | ARM token used against the data plane, or expired token | Switch to Mode A; if the token expired, ask the user for a fresh session |
| `AuthorizationFailed`, RBAC `403` | Token is valid, principal lacks the role | Report the missing role and scope. Stop |
| Proxy `Forbidden` / no HTTP response | Route or endpoint rule does not permit this path | Read the profile's `endpoint_rules` (Step 1) and report the required route |
| `ResourceNotFound` on a workspace path | `customerId` GUID used where `workspaceResourceName` belongs | Re-run `az_workspaces`; use the resource name |
| `InvalidSubscriptionId` / `SubscriptionNotFound` | Wrong subscription in the path | Take the subscription from `workspaceResourceId` |
| Table not found / `Failed to resolve table` | **Access works.** Wrong table name or logging mode | Run table discovery (below). Do not touch credentials |
| Query returns 0 rows | **Access works.** Wrong window, app field, revision, or ingestion lag | Widen the window, check the schema. Do not touch credentials |

The dividing line: the last two rows mean you are already inside the log database and the problem is the query. Everything above them means the query never ran.

## Table discovery

Container Apps environments write to `ContainerAppConsoleLogs_CL` in the default (Azure-table) logging mode; a workspace configured for resource-specific tables uses `ContainerAppConsoleLogs` without the `_CL` suffix. A "table not found" error is easy to misread as an empty result:

```bash
query_log "search * | where \$table startswith 'ContainerApp' | distinct \$table"
```

Then probe the schema before writing filters — Container App **Jobs** use different columns from apps:

```bash
query_log "ContainerAppConsoleLogs_CL | getschema"
query_log "ContainerAppConsoleLogs_CL | take 1"
```

| Resource | Name column | Log column |
|---|---|---|
| `Microsoft.App/containerApps` | `ContainerAppName_s` | `Log_s` |
| `Microsoft.App/jobs` | `ContainerJobName_s` | `Log_s` or `log_s` |

Never assume `ContainerAppName_s` for a job — filtering on a non-existent column returns zero rows and looks exactly like "nothing happened."

## Orienting with Azure Resource Graph

Resource Graph queries resource *metadata* across subscriptions — fast and cross-scope. Use it for discovery; use Log Analytics for runtime logs.

```
POST {ARM base}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01
Body: { "query": "<ARG query>" }
```

### Container apps and jobs in a resource group

```kql
resources
| where type in~ ('microsoft.app/containerapps', 'microsoft.app/jobs')
| where resourceGroup == '<resource-group>'
| project name, type, resourceGroup,
    envId = tostring(properties.managedEnvironmentId ?? properties.environmentId),
    image = properties.template.containers[0].image,
    revision = properties.latestRevisionName,
    provisioningState = properties.provisioningState
```

### The linked App Insights connection string

```kql
resources
| where type =~ 'microsoft.app/containerapps'
| where resourceGroup == '<resource-group>'
| extend appInsightsConnStr = tostring(properties.template.containers[0].env[?name=='APPLICATIONINSIGHTS_CONNECTION_STRING'].value)
| project name, appInsightsConnStr
```

## Inspecting resources via ARM

For details Resource Graph does not carry (env var values, revision history, job execution history). All URLs use the resolved `$AZ_ARM` base:

### Container app details

```bash
curl -s -H "Authorization: Bearer $AZ_TOKEN" \
  "$AZ_ARM/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.App/containerApps/<app-name>?api-version=2024-03-01"
```

| Field | Why it matters |
|-------|---------------|
| `.properties.latestRevisionName` | Newest revision — **not necessarily the one serving traffic** |
| `.properties.configuration.ingress.traffic` | Traffic weights per revision. Check before assuming which revision users hit |
| `.properties.configuration.ingress.targetPort` | Must match the port the container listens on, or every request 503s |
| `.properties.template.containers[0].image` | Image tag actually deployed |
| `.properties.template.containers[0].env` | Env vars; secret values show as `secretRef` |
| `.properties.template.scale` | `minReplicas` / `maxReplicas` — a zero-scaled app looks dead |

### Container App Job details and executions

```bash
curl -s -H "Authorization: Bearer $AZ_TOKEN" \
  "$AZ_ARM/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.App/jobs/<job-name>?api-version=2024-03-01"

curl -s -H "Authorization: Bearer $AZ_TOKEN" \
  "$AZ_ARM/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.App/jobs/<job-name>/executions?api-version=2024-03-01"
```

Jobs have no ingress or revisions. The fields that matter are `.properties.configuration.triggerType` (Manual / Schedule / Event), `replicaTimeout`, `replicaRetryLimit`, and per-execution `.properties.status`.

### A specific revision

```bash
curl -s -H "Authorization: Bearer $AZ_TOKEN" \
  "$AZ_ARM/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.App/containerApps/<app-name>/revisions/<revision>?api-version=2024-03-01"
```

### Comparing a working and a broken revision

Fetch both and diff `.properties.template` — image tag changes, env var additions or removals, altered resource limits. This is the fastest route to a root cause when the app "worked yesterday."
