# KQL Cookbook — Container Apps and Jobs

Companion to SKILL.md. Run these through the `query_log` helper in [access.md](access.md) — **after `az_gate` has printed OK**. Substitute `<app-name>` throughout.

Queries above the "Functions images" heading apply to any container app. Those below assume a Functions image.

## Probe the schema first

```kql
ContainerAppConsoleLogs_CL | getschema
```

```kql
ContainerAppConsoleLogs_CL | take 1
```

This is not optional ceremony: apps filter on `ContainerAppName_s`, Container App Jobs on `ContainerJobName_s`, and the log column is `Log_s` or `log_s` depending on the workspace. A filter on a column that does not exist returns zero rows and reads exactly like "the app logged nothing." Substitute the columns you actually saw into every query below.

## Container App Job — executions and output

```kql
ContainerAppConsoleLogs_CL
| where ContainerJobName_s == "<job-name>"
| where TimeGenerated > ago(24h)
| project TimeGenerated, ExecutionName_s, ContainerId_s, Log_s
| order by TimeGenerated asc
| take 200
```

Summarise per execution to see which run failed:

```kql
ContainerAppConsoleLogs_CL
| where ContainerJobName_s == "<job-name>"
| where TimeGenerated > ago(7d)
| summarize Lines=count(), Errors=countif(Log_s has "Error" or Log_s has "Traceback"),
            First=min(TimeGenerated), Last=max(TimeGenerated)
    by ExecutionName_s
| order by First desc
```

A job with zero rows for an execution that ARM reports as `Failed` never got as far as running your code — go to `ContainerAppSystemLogs_CL` for image pull and startup errors.

## Did the container start? (system logs first)

```kql
ContainerAppSystemLogs_CL
| where ContainerAppName_s == "<app-name>"
| where TimeGenerated > ago(1h)
| project TimeGenerated, RevisionName_s, Reason_s, Type_s, Log_s
| order by TimeGenerated asc
| take 100
```

Look for image pull failures, probe failures, OOM kills, and revision provisioning errors. If the container never started, **this is the only table with an answer** — console logs will be empty.

## All errors in console output, unfiltered

```kql
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "<app-name>"
| where TimeGenerated > ago(30m)
| where Log_s has "Error" or Log_s has "Exception" or Log_s has "Failed"
| project TimeGenerated, RevisionName_s, Log_s
| order by TimeGenerated asc
| take 50
```

Read the whole result before excluding anything. An exclusion clause that is slightly too broad will drop the line you need.

## Restart / crash loop detection

```kql
ContainerAppSystemLogs_CL
| where ContainerAppName_s == "<app-name>"
| where TimeGenerated > ago(2h)
| where Reason_s has_any ("BackOff", "Killing", "Unhealthy", "Failed", "ContainerCrashed")
| summarize Count=count(), First=min(TimeGenerated), Last=max(TimeGenerated)
    by Reason_s, RevisionName_s
| order by Last desc
```

Repeated `BackOff` or `Unhealthy` against one revision points at probe configuration or a container that exits on startup.

## Last words before a container died

```kql
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "<app-name>"
| where TimeGenerated between (ago(2h) .. now())
| order by TimeGenerated desc
| take 100
| order by TimeGenerated asc
```

The final lines before a restart are usually the actual failure. Sort descending to grab the tail, then re-sort ascending to read it forwards.

## Error volume by revision

Confirms whether a specific revision introduced the problem:

```kql
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "<app-name>"
| where TimeGenerated > ago(24h)
| where Log_s has "Error" or Log_s has "Exception"
| summarize Errors=count(), First=min(TimeGenerated), Last=max(TimeGenerated)
    by RevisionName_s
| order by First asc
```

A revision whose error count starts at deploy time and never stops is your regression.

## Which container apps are logging at all

Use when you are unsure of the exact app name:

```kql
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(1h)
| summarize Count=count(), Last=max(TimeGenerated) by ContainerAppName_s
| order by Last desc
```

## Replica-level view

When only some replicas misbehave:

```kql
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "<app-name>"
| where TimeGenerated > ago(1h)
| summarize Lines=count(), Errors=countif(Log_s has "Error")
    by ContainerId_s, RevisionName_s
| order by Errors desc
```

## Narrowing (only after reading the unfiltered output)

Keep exclusions narrow and literal:

```kql
| where Log_s !has "<the specific noise string>"
```

Excluding a whole category — anything matching "Storage", or a whole log prefix — is how root causes get lost. For Functions images specifically, never exclude `MS_FUNCTION_LOGS`.

---

# Functions images

Everything below assumes the container runs a Functions image. See the layer model in SKILL.md before interpreting results.

## Worker errors (layer 1 — check first)

```kql
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "<app-name>"
| where TimeGenerated > ago(30m)
| where Log_s has_any ("FunctionLoadError", "WorkerInitError", "cannot load",
                       "ErrorOccurredDuringStartupOperation")
| project TimeGenerated, Log_s
| order by TimeGenerated asc
```

## MS_FUNCTION_LOGS, parsed

Extracts fields instead of leaving you to eyeball raw JSON. `Level` >= 3 is Warning and above.

```kql
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "<app-name>"
| where TimeGenerated > ago(30m)
| where Log_s has "MS_FUNCTION_LOGS"
| extend payload = parse_json(extract(@'MS_FUNCTION_LOGS\s*(\{.*\})', 1, Log_s))
| where toint(payload.Level) >= 3
| project TimeGenerated, Level=payload.Level, Category=payload.Category,
          Message=payload.Message, Exception=payload.Exception
| order by TimeGenerated asc
```

Filter to layer 1 only by adding `| where Category startswith "Worker."`.

## Host lifecycle (layer 2)

```kql
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "<app-name>"
| where TimeGenerated > ago(30m)
| where Log_s has_any ("Host state changed", "Starting Host", "Host started",
                       "Stopping JobHost", "Bundle version")
| project TimeGenerated, RevisionName_s, Log_s
| order by TimeGenerated asc
```

Repeated `Starting Host` with no `Host started` between them is a crash loop. The cause is whatever appears in between.
