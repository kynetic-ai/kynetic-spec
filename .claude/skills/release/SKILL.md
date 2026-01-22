---
name: release
description: Create versioned releases with git tags and GitHub releases. CI publishes to npm, then create a PR to sync version.
---

# Release Skill

Create versioned releases with proper git tagging and GitHub release creation. CI publishes to npm; version sync requires a manual PR (due to branch protection).

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
| `BREAKING CHANGE:` in body or `feat!:` suffix | major |
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
1. Create version bump PR (package.json -> 0.1.2)
2. Merge PR
3. Create tag: v0.1.2
4. Push tag to origin
5. Create GitHub release with notes above
6. CI publishes to npm

Run without --dry-run to execute.
```

### Phase 6: Bump Version (PR)

**Before creating the release**, update package.json via PR:

```bash
VERSION="0.1.2"  # calculated version

# Create branch for version bump
git checkout -b release/v$VERSION

# Update version without creating a tag
npm version $VERSION --no-git-tag-version

# Commit and push
git add package.json package-lock.json
git commit -m "chore: bump version to $VERSION"
git push -u origin release/v$VERSION

# Create and merge PR
gh pr create --title "chore: bump version to $VERSION" --body "Prepare release v$VERSION"
gh pr merge --merge --delete-branch
```

**Why version bump first?**
- The tagged commit will have the correct version in package.json
- CI publishes whatever version is in package.json
- No sync PR needed after the fact

### Phase 7: Create Release

After the version PR is merged, pull main and create the release:

```bash
# Pull the merged version bump
git checkout main && git pull

# Create annotated tag
git tag -a "v$VERSION" -m "Release v$VERSION"

# Push tag
git push origin "v$VERSION"

# Create GitHub release
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
- Runs tests and publishes to npm with provenance
- package.json already has correct version (from Phase 6)

### Phase 8: Report Summary

After successful release:

```
## Release Complete

**Version:** v0.1.2
**Tag:** v0.1.2
**Commit:** abc1234

### Published
- [x] Version PR merged
- [x] Tag created: v0.1.2
- [x] Tag pushed to origin
- [x] GitHub release created
- [ ] CI publishing to npm...

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
Agent: [Validates state, creates version bump PR, merges it]
Agent: [Creates v0.1.2 tag, pushes, creates GH release]

Release v0.1.2 created successfully.
- Version PR: #122 (merged)
- GitHub release: https://github.com/kynetic-ai/kynetic-spec/releases/tag/v0.1.2
- CI publishing to npm...
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
- **CI handles publishing**: Skill creates release and version sync PR, CI publishes to npm
- **Branch protection compatible**: Version sync via PR, not direct push
- **kspec integration**: Surface completed tasks in release context

## Troubleshooting

### npm Trusted Publishers OIDC Failures

If npm publish fails with "Access token expired or revoked" + 404:

**Root cause:** Older npm versions (10.8.x bundled with Node 18) have bugs with OIDC authentication for trusted publishers.

**Fix:** Ensure the publish workflow installs `npm@latest`:
```yaml
- name: Install latest npm
  run: npm install -g npm@latest && npm --version
```

npm 11.x+ has the necessary fixes.

**Debugging tip:** When hitting opaque CI auth errors, search GitHub issues for the specific tool + error message before extensive local debugging.

## Related Skills

- `/pr` - Create pull requests before release
- `/audit` - Pre-release codebase review
- `/kspec` - Task completion tracking
