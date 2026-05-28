# Fix batch write buffer bypass in read paths

## Context

Batch operations that write to the same file from multiple commands lose data because `loadSpecFile()` and other read paths use raw `fs.readFile`/`fs.readdir`/`fs.access` instead of checking the in-memory write buffer. The confirmed symptom: two `item ac add` commands in the same batch targeting the same spec item — only the last AC survives because each command reads from disk (pre-batch state), not from the buffer.

The goal: every read and write to `.kspec/` files during batch execution must go through buffer-aware utilities so that:
1. **Atomic mode** — all commands see each other's writes (read-after-write consistency), rollback discards everything on failure
2. **Immediate mode with `--continue`** — each command commits individually
3. Commands behave identically whether run individually or in a batch

## Review Findings (Claude Plan agent + Codex)

Both reviewers converged on these critical gaps:
1. **`withFileTypes` Dirent synthesis** — `readdirBufferAware` must return Dirent-compatible objects
2. **Directory inference** — buffered `modules/foo/bar.yaml` must make `readdir(modules/)` show `foo` as a directory
3. **ENOENT overlay** — when disk dir doesn't exist but buffer has files in it, return buffered entries only
4. **Write bypasses** — `skill-crud.ts:387,904` and `skill-install.ts:257` use raw `fs.writeFile` on specDir paths
5. **Additional read bypasses** — `module.ts:92` (`fs.access`), `meta.ts:120` (`fs.access`), `skill-install.ts:250` (`fs.readFile`)
6. **Spec gap** — ac-2 covers file reads but not directory listing overlay

## Changes

### 1. `WriteBuffer` extensions — `src/cli/batch-write-buffer.ts`

Add methods to the `WriteBuffer` class:

**`listDir(directory, opts?)`** — overlay buffered entries onto real `readdir`:
- Call `fs.readdir(directory, opts)` — catch ENOENT and use empty array as base
- Scan buffer entries for paths whose `path.dirname()` is the directory
- Add buffered file entries (as `SyntheticDirent` if `withFileTypes: true`)
- Infer intermediate directories: if buffer has `dir/sub/file.yaml`, listing `dir/` shows `sub` as a directory entry
- Remove entries that were deleted in buffer (content === `null`)
- Deduplicate (buffer entry overrides disk entry for same name)

**`SyntheticDirent` class** — minimal `Dirent`-compatible object:
```typescript
class SyntheticDirent {
  name: string;
  private _isFile: boolean;
  isFile() { return this._isFile; }
  isDirectory() { return !this._isFile; }
  // Other Dirent methods return false
}
```

**Module-level helpers:**
- `readdirBufferAware(dir, opts?)` — checks active buffer, delegates to `listDir` or falls through to `fs.readdir`
- `accessBufferAware(filePath)` — checks buffer for file existence before `fs.access`
- `writeFileBufferAware(filePath, content)` — buffer-aware raw string write (non-YAML content like SKILL.md)

### 2. `readFileBufferAware()` — `src/parser/yaml.ts`

Raw-string counterpart to `readYamlFile()`:
```typescript
export async function readFileBufferAware(filePath: string): Promise<string> {
  const buffer = getActiveBatchBuffer();
  if (buffer?.isInScope(filePath)) {
    const buffered = buffer.read(filePath);
    if (buffered !== undefined) {
      if (buffered === null) {
        throw Object.assign(new Error(`ENOENT: ...`), { code: "ENOENT" });
      }
      return buffered;
    }
  }
  return fs.readFile(filePath, "utf-8");
}
```

### 3. Wire ALL `.kspec/` read paths — `src/parser/yaml.ts`

| Line | Function | Current | Fix |
|------|----------|---------|-----|
| 1279 | `loadSpecFile()` | `fs.readFile` | → `readFileBufferAware` |
| 200 | `findTaskFiles()` | `fs.readdir` | → `readdirBufferAware` |
| 452 | `findManifestInDir()` | `fs.access` | → `accessBufferAware` |
| 461 | `findManifestInDir()` | `fs.readdir` | → `readdirBufferAware` |
| 555 | `loadAllTasks()` | `fs.access` | → `accessBufferAware` |
| 599 | `loadAllTasks()` | `fs.access` | → `accessBufferAware` |
| 1077 | `expandIncludePattern()` | `fs.access` | → `accessBufferAware` |
| 1117 | `expandGlobRecursive()` | `fs.readdir` | → `readdirBufferAware` |

### 4. Wire ALL `.kspec/` read paths — `src/parser/meta.ts`

| Line | Function | Current | Fix |
|------|----------|---------|-----|
| 120 | `findMetaManifest()` | `fs.access` | → `accessBufferAware` |
| 128 | `findMetaManifest()` | `fs.readdir` | → `readdirBufferAware` |
| 601 | `loadSkillContent()` | `fs.readFile` | → `readFileBufferAware` |
| 662 | `loadSkillDocs()` | `fs.readdir` | → `readdirBufferAware` |
| 668 | `loadSkillDocs()` | `fs.readFile` | → `readFileBufferAware` |
| 716 | `loadSkillSupportingFiles()` | `fs.readdir` | → `readdirBufferAware` |
| 722 | `loadSkillSupportingFiles()` | `fs.readFile` | → `readFileBufferAware` |

### 5. Fix write bypasses in batchable commands

| File | Line | Function | Current | Fix |
|------|------|----------|---------|-----|
| `src/cli/commands/skill-crud.ts` | 387 | `skill add` | `fs.writeFile(skillMdPath, ...)` | → `writeFileBufferAware` |
| `src/cli/commands/skill-crud.ts` | 904 | `skill import` | `fs.writeFile(skillMdPath, ...)` | → `writeFileBufferAware` |
| `src/cli/commands/skill-install.ts` | 257 | `copyCoreSkillFiles` | `fs.writeFile(targetSkillMd, ...)` | → `writeFileBufferAware` |
| `src/cli/commands/skill-install.ts` | 250 | `copyCoreSkillFiles` | `fs.readFile(targetSkillMd, ...)` | → `readFileBufferAware` |
| `src/cli/commands/skill-install.ts` | 192-193 | `sourceMatchesDest` | `fs.readdir` (src/dest) | → `readdirBufferAware` for dest (specDir), raw for src (templates) |

### 6. Fix access bypass in batchable command

| File | Line | Function | Current | Fix |
|------|------|----------|---------|-----|
| `src/cli/commands/module.ts` | 92 | `module add` | `fs.access(moduleFilePath)` | → `accessBufferAware` |

### 7. Out of scope (outside `.kspec/`, or never called during batch)

- `shadow.ts` — `.git` internals
- `skill-render.ts` — `.agents/skills/` rendered output (target is outside specDir)
- `validate.ts`, `validate-skills.ts` — test/skill output directories
- `config.ts` — `.claude/settings.json`
- `setup-seeding.ts` — only called during `kspec setup`, never during batch
- `prompts.ts:63` — `.agents/skills/` (outside specDir)
- `prompts.ts:118` — agent runtime only, never during batch
- `batch-exec.ts:165` — reads batch input file (user path)
- `skill-install.ts:192` source dir reads — templates/ (outside specDir, read-only)
- `skill-crud.ts:911-915` — `fs.stat` + `copyDirectory` for supporting dirs during import; source is user filesystem, not specDir. The target writes (`copyDirectory` writing to specDir) should also use buffer-aware helpers.

### 8. Spec update

Update `@batch-write-buffer` AC text to clarify directory listing coverage:
- ac-2: add explicit mention that `readdir` and `access` are also covered by buffer-aware helpers
- Consider adding ac-9 for directory listing overlay specifically (buffered files appear, deleted files excluded, intermediate directories inferred)

### 9. Tests — `tests/batch-write-buffer.test.ts`

**Unit tests for new helpers:**
- `WriteBuffer.listDir()` — overlay disk + buffer entries, exclude deleted, infer directories, handle ENOENT on disk dir
- `SyntheticDirent` — `.isFile()`, `.isDirectory()`, `.name`
- `readdirBufferAware()` with `{ withFileTypes: true }` — returns Dirent-compatible objects
- `accessBufferAware()` — succeeds for buffered files, throws for deleted, falls through for unbuffered
- `writeFileBufferAware()` — writes to buffer during batch, falls through to disk outside batch
- `readFileBufferAware()` — buffer hit, buffer miss, deleted file

**Integration tests (confirmed bug):**
- Two `item ac add` commands to same spec item → both ACs survive
- `module add` followed by duplicate check in same batch → second correctly detects conflict
- Batch with skill operations → skill content readable within same batch

## Files to modify

1. `src/cli/batch-write-buffer.ts` — `SyntheticDirent`, `listDir()`, `readdirBufferAware()`, `accessBufferAware()`, `writeFileBufferAware()`
2. `src/parser/yaml.ts` — `readFileBufferAware()`, wire into `loadSpecFile`, `findTaskFiles`, `findManifestInDir`, `loadAllTasks`, `expandIncludePattern`, `expandGlobRecursive`
3. `src/parser/meta.ts` — wire into `findMetaManifest`, `loadSkillContent`, `loadSkillDocs`, `loadSkillSupportingFiles`
4. `src/cli/commands/skill-crud.ts` — wire `writeFileBufferAware` into `skill add` and `skill import`
5. `src/cli/commands/skill-install.ts` — wire buffer-aware helpers into `copyCoreSkillFiles` and `sourceMatchesDest`
6. `src/cli/commands/module.ts` — wire `accessBufferAware` into `module add`
7. `tests/batch-write-buffer.test.ts` — new unit + integration tests

## Verification

```bash
# Unit tests
npx vitest run tests/batch-write-buffer.test.ts

# The confirmed bug
kspec batch --commands '[
  {"command":"item ac add","args":{"ref":"@some-spec","given":"G1","when":"W1","then":"T1"}},
  {"command":"item ac add","args":{"ref":"@some-spec","given":"G2","when":"W2","then":"T2"}}
]'
# kspec item get @some-spec → both ACs present

# Full test suite
npx vitest run
```
