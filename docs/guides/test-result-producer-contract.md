# Test Result Producer Contract

`kspec coverage test-result ingest` accepts one normalized JSON envelope for completed test runs. Test frameworks, CI jobs, local scripts, and agent tools translate their native output into this envelope before calling the CLI or daemon ingestion route. The core ingestion path does not accept framework-native result files as its storage model.

## Storage Layout

Accepted runs are stored in the project metadata sidecar:

```text
coverage/test-runs/index.yaml
coverage/test-runs/runs/<run-ulid>/run.yaml
```

`index.yaml` is the bounded summary and latest-run index. Each `run.yaml` is the authoritative run record for detailed cases, mappings, diagnostics, producer metadata, and verification effects. Ingestion only writes this sidecar and related verification records; it does not rewrite spec source files or project source files.

Index entries have this shape:

```yaml
format: 1
runs:
  01ARZ3NDEKTSV4RRFFQ69G5FAV:
    path: runs/01ARZ3NDEKTSV4RRFFQ69G5FAV/run.yaml
    completed_at: "2026-06-22T21:15:00.000Z"
    producer:
      kind: local
      label: portable-contract-checks
    code_revision: abc123
    totals:
      cases: 2
      mapped: 1
      unmapped: 1
      invalid: 0
      passed: 1
      failed: 0
      errored: 0
      skipped: 1
      unknown: 0
      stamps_written: 1
latest_run_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
```

## Normalized Envelope

Submit JSON with these top-level fields:

```json
{
  "format": 1,
  "run": {
    "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "completed_at": "2026-06-22T21:15:00.000Z",
    "started_at": "2026-06-22T21:14:10.000Z",
    "duration_ms": 50000
  },
  "producer": {
    "kind": "local",
    "label": "portable-contract-checks",
    "command": "npm test",
    "code_revision": "abc123",
    "native": {
      "adapter_run_id": "producer-owned-id"
    }
  },
  "cases": [
    {
      "id": "contracts/exports-report",
      "display_name": "exports a portable report",
      "suite_path": ["adapter contract"],
      "status": "passed",
      "duration_ms": 12,
      "location": {
        "file": "checks/report.contract",
        "line": 42
      },
      "diagnostic": null,
      "refs": [
        {
          "item_ref": "@portable-reporting",
          "ac_id": "ac-exports-report"
        }
      ]
    }
  ]
}
```

Required fields:

- `format`: currently `1`.
- `run.id`: canonical kspec run ULID. Do not use a framework run id, timestamp, test name, or file path.
- `run.completed_at`: ISO timestamp for the completed run.
- `producer.kind`: one of `local`, `ci`, `agent`, or `other`.
- `producer.label`: human-readable producer name.
- `cases`: non-empty array.
- `cases[].id`: stable case id supplied by the producer or adapter.
- `cases[].display_name`: human-readable case name.
- `cases[].status`: one of `passed`, `failed`, `errored`, `skipped`, or `unknown`.

Optional fields:

- `run.started_at`, `run.duration_ms`
- `producer.command`, `producer.ci_url`, `producer.agent_session`, `producer.code_revision`
- `producer.native` for namespaced producer-native metadata retained for diagnostics
- `cases[].suite_path`, `cases[].duration_ms`, `cases[].location`, `cases[].diagnostic`, `cases[].refs`

Unknown framework-native top-level fields are rejected. Keep native details under `producer.native` only when they are useful for later diagnosis.

## Case Statuses

Use only the normalized status vocabulary:

- `passed`: positive coverage evidence when mapped to an existing criterion.
- `failed`: retained as non-positive mapped evidence.
- `errored`: retained as non-positive mapped evidence.
- `skipped`: retained, but never positive coverage evidence.
- `unknown`: retained, but never positive coverage evidence.

`skipped` and `unknown` cases can be mapped for diagnostics, but they do not write positive verification stamps.

## Mapping References

Each case may carry zero or more normalized acceptance-criterion references:

```json
{
  "item_ref": "@portable-reporting",
  "ac_id": "ac-exports-report"
}
```

`item_ref` resolves through the project's kspec ref index. `ac_id` names the criterion on that item. Invalid or absent references do not discard the case: accepted runs retain invalid mappings and unmapped cases so later UI, CLI, or validation surfaces can report them.

Adapters may extract agreed tokens from native suite or test names before normalization. For example, a native display string containing `AC: @portable-reporting ac-exports-report` can become the explicit `refs` array above. Token extraction is adapter work; core ingestion still receives explicit normalized refs.

## Producer Examples

Local producer:

```json
{
  "kind": "local",
  "label": "portable-contract-checks",
  "command": "npm test",
  "code_revision": "abc123"
}
```

CI producer:

```json
{
  "kind": "ci",
  "label": "hosted-linux-tests",
  "ci_url": "https://ci.example.invalid/runs/42",
  "code_revision": "abc123"
}
```

Agent producer:

```json
{
  "kind": "agent",
  "label": "task-worker-checks",
  "agent_session": "01CRZ3NDEKTSV4RRFFQ69G5FAV",
  "code_revision": "abc123"
}
```

No producer kind requires every source field. A local run can omit `ci_url`; a CI run can omit `command`; an agent run can omit `agent_session` when no session is available.

## Adapter Boundary

Framework-native payloads are adapter inputs, not core ingestion inputs. An adapter reads the native result, chooses stable case ids, preserves diagnostic text, extracts or receives acceptance-criterion refs, and submits the normalized envelope.

Do not submit native fields such as framework assertion counters, test-file arrays, XML elements, or job-specific artifact lists at the top level. If a native value helps later debugging, place a small namespaced copy under `producer.native` and keep the normalized `cases` array as the source of truth.

## CLI Usage

```bash
kspec coverage test-result ingest --file result.normalized.json --json
kspec coverage test-result ingest --file result.normalized.json --dry-run --json
cat result.normalized.json | kspec coverage test-result ingest - --actor "CI Bot"
```

Use `--dry-run` to validate, map, and preview the run without writing sidecar files, verification stamps, shadow commits, cache updates, or events.
