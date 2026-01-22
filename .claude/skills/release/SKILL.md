---
name: release
description: Create versioned releases with git tags and GitHub releases. CI automatically syncs version and publishes to npm.
---

# Release Skill

Create versioned releases with proper git tagging and GitHub release creation. CI handles version syncing and npm publishing automatically.

## When to Use

- After completing features/fixes ready for release
- When creating patch/minor/major version bumps
- For pre-release versions (alpha, beta, rc)
- When auditing what changes would be in a release (`--dry-run`)

## Arguments

```
/release [patch|minor|major] [options]
```

| Argument | Description |
|----------|-------------|
| `patch` | Bug fixes, backwards-compatible (0.1.1 -> 0.1.2) |
| `minor` | New features, backwards-compatible (0.1.1 -> 0.2.0) |
| `major` | Breaking changes (0.1.1 -> 1.0.0) |
| (none) | Auto-detect from commits since last tag |

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview what would happen without making changes |
| `--prerelease <type>` | Create prerelease (alpha, beta, rc) |

## Workflow

### Phase 1: Detect Context

Gather information about current state:

```bash
# Get current branch
git branch --show-current

# Check for uncommitted changes
git status --porcelain

# Get current version from package.json (for display)
node -p "require('./package.json').version"

# Get last tag
git describe --tags --abbrev=0 2>/dev/null || echo "no-tags"

# Get commits since last tag (merge commits only for clean history)
git log $(git describe --tags --abbrev=0 2>/dev/null)..HEAD --oneline --merges
# If no merges, fall back to all commits
git log $(git describe --tags --abbrev=0 2>/dev/null)..HEAD --oneline
```

**Context to gather:**
- Current branch
- Working tree status (clean/dirty)
- Current version in package.json
- Last tag (e.g., v0.1.1)
- Commits since last tag (count and list)

### Phase 2: Validate Constraints

All constraints must pass before proceeding:

| Constraint | Check | Error Message |
|------------|-------|---------------|
| On main branch | `git branch --show-current` = main | "Must be on main branch. Currently on: {branch}" |
| Clean working tree | `git status --porcelain` is empty | "Working tree must be clean. Commit or stash changes first." |
| Up to date with origin | After `git fetch`, local matches remote | "Local main is behind origin. Run: git pull" |
| Has releasable changes | Commits exist since last tag | "No changes since last tag {tag}. Nothing to release." |
| Tag doesn't exist | `git tag -l v{version}` is empty | "Tag v{version} already exists." |

**Dry-run behavior:** In dry-run mode, report all validation results but continue to show what would happen.

### Phase 3: Determine Version

If version type not specified, auto-detect from commits:

```bash
# Get commit messages since last tag
git log $(git describe --tags --abbrev=0)..HEAD --pretty=format:"%s"
```

**Auto-detection rules (conventional commits):**

| Pattern | Bump |
|---------|------|
| `BREAKING CHANGE:` in body or `!` after type | major |
| `feat:` or `feat(scope):` | minor |
| `fix:`, `perf:`, `refactor:`, `chore:` | patch |

**Resolution order:**
1. If any commit has breaking change -> major
2. Else if any commit is `feat:` -> minor
3. Else -> patch

**Prerelease handling (`--prerelease <type>`):**

| Current | Type | Result |
|---------|------|--------|
| 0.1.1 | alpha | 0.1.2-alpha.0 |
| 0.1.2-alpha.0 | alpha | 0.1.2-alpha.1 |
| 0.1.2-alpha.1 | beta | 0.1.2-beta.0 |
| 0.1.2-rc.0 | (stable) | 0.1.2 |

### Phase 4: Analyze Changes for Release Notes

Parse commits and categorize them for user-friendly release notes.

**Filtering rules:**
- **Include**: Merge commits with `(#N)` pattern (to avoid duplicates from branch commits)
- **Include**: `feat:`, `fix:`, `perf:`, `refactor:` (if user-facing)
- **Exclude**: `test:` commits, `docs:` commits (unless bundled with code), `ci:` commits
- **Transform**: Convert commit messages to friendly descriptions

**Categorization:**
- `feat:` -> Features & Additions
- `fix:` -> Bug Fixes
- `perf:`, `refactor:`, `chore:` -> Other Changes

**kspec integration:**
```bash
# Extract task references from commit trailers
git log $(git describe --tags --abbrev=0)..HEAD --pretty=format:"%b" | grep -E "^Task: @" | sort -u
```

### Phase 5: Preview (--dry-run)

For `--dry-run`, show comprehensive preview:

```
## Release Preview

**Version bump:** 0.1.1 -> 0.1.2 (patch)
**Detection:** Auto-detected from 5 commits (3 fix, 2 chore)

### Validation
- [x] On main branch
- [x] Working tree clean
- [x] Up to date with origin
- [x] Has 5 commits since v0.1.1
- [x] Tag v0.1.2 does not exist

### Release Notes Preview

Bug fixes and improvements for kspec CLI.

#### Features & Additions
- Add JSON output mode for task list

#### Bug Fixes
- Fix author attribution for auto-generated notes
- Increase timeout for ref resolution

### Actions (would execute)
1. Create tag: v0.1.2
2. Push tag to origin
3. Create GitHub release with notes above
4. CI will sync version and publish to npm

Run without --dry-run to execute.
```

### Phase 6: Execute Release

**Step 1: Create annotated tag**
```bash
VERSION="0.1.2"  # calculated version
git tag -a "v$VERSION" -m "Release v$VERSION"
```

**Step 2: Push tag**
```bash
git push origin "v$VERSION"
```

**Step 3: Create GitHub release**
```bash
gh release create "v$VERSION" \
  --title "v$VERSION" \
  --notes "$(cat <<'EOF'
Brief summary of this release.

### Features & Additions
- Feature description

### Bug Fixes
- Fix description

### Other Changes
- Change description

**Full Changelog**: https://github.com/owner/repo/compare/v0.1.1...v0.1.2
EOF
)"
```

**CI automatically:**
- Triggers on `release.published` event
- Syncs version in package.json from tag
- Runs tests and publishes to npm
- Commits version back to main

### Phase 7: Report Summary

After successful release:

```
## Release Complete

**Version:** v0.1.2
**Tag:** v0.1.2
**Commit:** abc1234

### Published
- [x] Tag created: v0.1.2
- [x] Tag pushed to origin
- [x] GitHub release created

### Next Steps
- CI will automatically:
  - Sync package.json version
  - Run tests
  - Publish to npm
  - Commit version back to main

**Release:** https://github.com/owner/repo/releases/tag/v0.1.2
```

## Release Notes Format

Generate **friendly, user-facing release notes** (not raw commit dumps):

```markdown
Brief high-level summary of what this release brings (1-2 sentences describing the theme or main improvements).

### Features & Additions
- Feature description in plain language
- Another feature

### Bug Fixes
- Fixed issue with X when Y happened
- Resolved problem where Z

### Other Changes
- Improved performance of X
- Updated internal handling of Y

**Full Changelog**: https://github.com/owner/repo/compare/v0.1.1...v0.1.2
```

**Writing guidelines:**
- Write in past tense ("Fixed", "Added", "Improved")
- Focus on user impact, not implementation details
- Group related changes together
- Omit test-only and CI-only changes

## Error Handling

| Error | Recovery |
|-------|----------|
| Not on main | `git checkout main && git pull` |
| Dirty working tree | Commit or stash changes first |
| Behind origin | `git pull origin main` |
| No changes | Nothing to release since last tag |
| Tag exists | Choose a different version or delete existing tag |
| Push rejected | Check remote permissions |
| gh not installed | Install GitHub CLI: https://cli.github.com/ |
| Not authenticated | Run `gh auth login` |

## Examples

### Standard patch release
```
User: /release patch
Agent: [Validates state, creates v0.1.2 tag, pushes, creates GH release]

Release v0.1.2 created successfully.
GitHub release: https://github.com/kynetic-ai/kynetic-spec/releases/tag/v0.1.2
CI will sync version and publish to npm automatically.
```

### Auto-detect version
```
User: /release
Agent: [Analyzes commits, finds 2 feat: commits]
Detected: 2 feature commits -> minor bump (0.1.1 -> 0.2.0)
[Proceeds with release]
```

### Preview only
```
User: /release --dry-run
Agent: [Shows full preview without making changes]
```

### Pre-release
```
User: /release minor --prerelease alpha
Agent: [Creates v0.2.0-alpha.0]
```

## Key Principles

- **Validation first**: Check all constraints before any changes
- **Dry-run shows everything**: Preview should be comprehensive enough to catch issues
- **Friendly release notes**: Write for users, not developers
- **CI handles publishing**: Skill creates release, CI does the rest
- **kspec integration**: Surface completed tasks in release context

## Related Skills

- `/pr` - Create pull requests before release
- `/audit` - Pre-release codebase review
- `/kspec` - Task completion tracking
