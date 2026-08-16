# Access and Querying

Companion to SKILL.md. Covers authentication, the reusable Log Analytics query helper, and resource inspection via Resource Graph and ARM.

Nothing here is workload-specific — it applies to any Azure Container App.

Placeholder convention throughout: `<subscription-id>`, `<resource-group>`, `<workspace-name>`, `<app-name>`, `<revision>`.

## Authentication

**Run this before any Azure command, including `az`:**

```bash
printenv NONO_CAP_FILE
printenv | grep -iE 'azure|bearer|arm_|token'
```

Use `printenv`, not `env` — `env` is commonly blocked by the permission system, and a denial there is what tempts a fallback to `az`. An empty `NONO_CAP_FILE` means you are outside a sandbox; anything else means you are inside one.

Branch on the result:

| `NONO_CAP_FILE` | Token var found | What to do |
|---|---|---|
| set | yes | Use the token directly. **Do not run `az`** |
| set | no | Wrong nono profile — stop and tell the user (see below). **Do not run `az`** |
| unset | — | Azure CLI or service principal, below |

### Inside a sandbox (e.g. nono)

Credentials are injected by a proxy layer. Assign whichever variable holds the token and use it directly — no login:

```bash
TOKEN="$AZURE_MANAGEMENT_BEARER_TOKEN"   # example — actual name may differ
```

The proxy handles routing, so direct `management.azure.com` calls work with no further setup.

**`az` does not work inside nono. Do not try it, and do not retry it with `dangerouslyDisableSandbox`.** The sandbox does not grant `~/.azure`, so the CLI dies before parsing any command:

```
PermissionError: [Errno 1] Operation not permitted: '/Users/choesler/.azure/azureProfile.json'
```

This is nono's outer sandbox, below the Claude Code permission layer, so no flag or retry gets past it. Pointing `AZURE_CONFIG_DIR` at a writable directory makes `az` start, but against an empty profile with no credentials — also a dead end. Every second spent here is wasted.

**If no token variable exists,** injection is not active for this session — the credential is granted per nono profile, and the failure is silent. Do not fall back to `az`. Report to the user that the session needs a profile carrying an Azure credential, and check what the current one grants:

```bash
cat "$NONO_CAP_FILE"    # look for custom_credentials and allowed_domains
```

`allowed_domains: []` and no credential entries confirms this session cannot reach Azure at all. Note that profiles also scope which subscriptions and resource groups are reachable, so a token alone does not guarantee access to a given resource.

### Outside a sandbox

Only when `NONO_CAP_FILE` is unset:

```bash
# From Azure CLI
TOKEN=$(az account get-access-token --query accessToken -o tsv)

# From a service principal
TOKEN=$(curl -s -X POST \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&resource=https://management.azure.com/" \
  "https://login.microsoftonline.com/$TENANT_ID/oauth2/token" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
```

Verify the token works before debugging anything else:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://management.azure.com/subscriptions?api-version=2020-01-01"
```

## The query helper

Function Apps on Container Apps log to Log Analytics. Query through the management API — `api.loganalytics.io` requires a separately-scoped token.

Define this once at the start of a session:

```bash
SUB="<subscription-id>"; RG="<resource-group>"; WS="<workspace-name>"

query_log() {
  curl -s -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": $(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
    "https://management.azure.com/subscriptions/$SUB/resourcegroups/$RG/providers/Microsoft.OperationalInsights/workspaces/$WS/api/query?api-version=2017-01-01-preview" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
if 'error' in d:
    print('ERROR:', json.dumps(d['error'])[:500]); sys.exit(1)
t = (d.get('Tables') or d.get('tables') or [{}])[0]
for r in t.get('Rows', t.get('rows', [])):
    print(' | '.join(str(c)[:300] for c in r))
"
}
```

Usage:

```bash
query_log "
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == '<app-name>'
| take 10
"
```

### If the table is not found

Container Apps environments write to `ContainerAppConsoleLogs_CL` under the default (Azure-table) logging mode, but a workspace configured for resource-specific tables uses `ContainerAppConsoleLogs` without the `_CL` suffix. A "table not found" error is easy to misread as an empty result. Confirm which exists:

```bash
query_log "search * | where \$table startswith 'ContainerApp' | distinct \$table"
```

## Orienting with Azure Resource Graph

Resource Graph queries resource *metadata* across subscriptions — fast and cross-scope. Use it for discovery (what exists, what's linked); use Log Analytics for runtime logs.

```
POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01
Body: { "query": "<ARG query>" }
```

### Find Container Apps and their linked workspace

```kql
resources
| where type =~ 'microsoft.app/managedenvironments'
| where resourceGroup == '<resource-group>'
| project envName=name, envId=id, workspaceId=properties.appLogsConfiguration.logAnalyticsConfiguration.customerId
| join kind=inner (
    resources
    | where type =~ 'microsoft.app/containerapps'
    | project appName=name, envId=tostring(properties.managedEnvironmentId), image=properties.template.containers[0].image
) on envId
| project appName, image, envName, workspaceId
```

### Find the linked App Insights connection string

```kql
resources
| where type =~ 'microsoft.app/containerapps'
| where resourceGroup == '<resource-group>'
| extend appInsightsConnStr = tostring(properties.template.containers[0].env[?name=='APPLICATIONINSIGHTS_CONNECTION_STRING'].value)
| project name, appInsightsConnStr
```

### List container apps with revision and image

```kql
resources
| where type =~ 'microsoft.app/containerapps'
| where resourceGroup == '<resource-group>'
| project name, revision=properties.latestRevisionName,
    image=properties.template.containers[0].image,
    provisioningState=properties.provisioningState
```

## Inspecting resources via ARM

For details Resource Graph does not carry (env var values, revision history):

### Container app details

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://management.azure.com/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.App/containerApps/<app-name>?api-version=2024-03-01"
```

Key fields:

| Field | Why it matters |
|-------|---------------|
| `.properties.latestRevisionName` | Newest revision — **not necessarily the one serving traffic** |
| `.properties.configuration.ingress.traffic` | Traffic weights per revision. Check this before assuming which revision users hit |
| `.properties.configuration.ingress.targetPort` | Must match the port the container listens on, or every request 503s |
| `.properties.template.containers[0].image` | Image tag actually deployed |
| `.properties.template.containers[0].env` | Env vars; secret values show as `secretRef` |
| `.properties.template.scale` | `minReplicas` / `maxReplicas` — a zero-scaled app looks dead |

### A specific revision

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://management.azure.com/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.App/containerApps/<app-name>/revisions/<revision>?api-version=2024-03-01"
```

### Comparing a working and a broken revision

Fetch both and diff `.properties.template` — look for image tag changes, env var additions or removals, and altered resource limits. This is the fastest route to a root cause when the app "worked yesterday."
