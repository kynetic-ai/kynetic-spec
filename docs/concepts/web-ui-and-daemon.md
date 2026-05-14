# The Web UI and the Daemon

kspec provides two runtime surfaces beyond the CLI: a local daemon that serves an API, and a web UI that presents project state in a browser. Both are optional — the CLI is fully self-contained — but they offer a different way to interact with your specs and tasks.

## Why They Exist

The CLI is the primary interface for kspec. It's fast, scriptable, and works in any terminal. But some activities are better served by a visual interface:

- **Browsing specs and tasks** is easier when you can see the hierarchy, filter by status, and click through relationships rather than running a sequence of CLI commands.
- **Reading documentation** is more comfortable in a rendered format with navigation, search, and syntax-highlighted code blocks.
- **Monitoring agent activity** is clearer when you can watch task state changes in real time rather than polling the CLI.

The daemon and web UI serve these needs without replacing the CLI. They read the same state from the shadow branch and present it through a different lens.

## What the Daemon Does

The daemon is a local HTTP server that provides a JSON API over kspec's state. It runs on your machine (default port 3456) and watches the shadow branch for changes.

Its responsibilities include:

- **Serving project data.** Specs, tasks, plans, inbox items, reviews — all available through REST endpoints.
- **File watching.** The daemon monitors the shadow branch for changes and invalidates its cache accordingly. When a CLI command modifies state, the daemon picks up the change without needing a restart.
- **Supporting the web UI.** The web UI is a static SvelteKit application that connects to the daemon's API. Without the daemon running, the web UI can still render documentation (which is bundled at build time) but cannot display live project state.
- **Hosting the dispatch engine.** When agent dispatch is running, it operates within the daemon process. Stopping the daemon stops dispatch.

The daemon is started and stopped through the CLI. A health check endpoint lets you verify it's running.

## What the Web UI Shows

The web UI is a local browser application that gives you a visual overview of your project:

- **Spec tree.** Browse the hierarchy of modules, features, requirements, and their acceptance criteria.
- **Task board.** See tasks grouped by status, with links to their specs and review records.
- **Documentation.** Project docs are bundled at build time and rendered with navigation, a table of contents, and syntax highlighting. This works even without the daemon — the content is embedded in the build.
- **Activity.** See recent changes across specs and tasks.

The web UI does not replace the CLI for making changes. It's a read-mostly surface — useful for orientation and review, while the CLI handles mutations.

## How They Surface in Use

**Starting the daemon.** The daemon launches when you need it — for the web UI, for dispatch, or for API access. It's not required for basic CLI operations.

**Browsing the web UI.** The dev server runs on port 5173 and connects to the daemon on port 3456. In production builds, the web UI is a static site that can be served alongside your project's other documentation.

**During development.** If you're developing kspec itself, the web UI dev server supports hot module replacement. For users of kspec, the web UI is pre-built and served by the daemon.

**When the daemon is down.** Everything still works through the CLI. The web UI's documentation pages render from bundled content, so docs are available even without a running daemon. Live project state requires the daemon.

The key distinction: the CLI is the source of truth and the mutation interface. The daemon and web UI are read surfaces that make the same information more accessible in different contexts.
