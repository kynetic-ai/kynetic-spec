# Multi-Directory Daemon Test Fixtures

Test fixtures for multi-directory daemon functionality (AC coverage for @multi-directory-daemon).

## Structure

```
multi-dir/
├── project-a/           # Valid kspec project (can be default)
│   └── .kspec/
│       ├── kynetic.yaml
│       ├── project.tasks.yaml
│       └── modules/
│           └── test.yaml
├── project-b/           # Second valid kspec project
│   └── .kspec/
│       ├── kynetic.yaml
│       ├── project.tasks.yaml
│       └── modules/
│           └── test.yaml
├── project-invalid/     # Invalid project (no .kspec/)
│   └── README.md
└── README.md            # This file
```

## Usage

### Setup Multi-Directory Fixtures

Use the helper function to copy fixtures to a temp directory:

```typescript
import { setupMultiDirFixtures } from '../helpers/cli';

const fixturesRoot = await setupMultiDirFixtures();
const projectA = path.join(fixturesRoot, 'project-a');
const projectB = path.join(fixturesRoot, 'project-b');
const projectInvalid = path.join(fixturesRoot, 'project-invalid');
```

### Symlink Testing (AC-8c)

For symlink tests, create symlinks at test runtime:

```typescript
import { symlink } from 'node:fs/promises';

// Create symlink to project-a
const symlinkPath = path.join(fixturesRoot, 'project-a-symlink');
await symlink(projectA, symlinkPath, 'dir');
```

## Test Coverage

These fixtures support testing:

- **AC-1**: Request with X-Kspec-Dir header
- **AC-2**: Default project (no header)
- **AC-3**: No default project (start from invalid dir)
- **AC-4**: Auto-registration of new project
- **AC-5**: Invalid project path (no .kspec/)
- **AC-6**: Relative path rejection
- **AC-7**: Parent traversal rejection ("..")
- **AC-8**: Path normalization
- **AC-8c**: Symlink handling (paths NOT resolved)
- **AC-16**: Concurrent registration of same project
- **AC-17**: Per-project file watchers
- **AC-18**: Scoped WebSocket updates
- **AC-20**: Deleted project handling
- **AC-24**: Project data isolation (no cross-project leakage)
- **AC-25-27**: UI project selector
- **AC-28-30**: /api/projects endpoints

## Project Data

### Project A
- Project name: "Test Project A"
- Task: @task-a-sample (pending, priority 1)
- Spec: @spec-a-sample (requirement)

### Project B
- Project name: "Test Project B"
- Task: @task-b-sample (in_progress, priority 2)
- Spec: @spec-b-sample (feature)

Different states and priorities allow testing cross-project isolation.
