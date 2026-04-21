# Daemon Cannot Start Because the Port Is Already in Use

You try to start the kspec daemon and see an error that the port (default 3456) is already in use, or the daemon fails to bind and exits immediately.

## What This Means

The [kspec daemon](../concepts/web-ui-and-daemon.md) is a local HTTP server that serves the API and hosts the web UI. It needs an available TCP port to listen on. When port 3456 is already occupied, the daemon cannot start.

Common causes:

- A previous daemon instance is still running (perhaps from an earlier session that wasn't stopped cleanly).
- Another application on your machine is using port 3456.
- A dispatch engine session left a daemon process running in the background.

## How to Fix It

First, check whether a kspec daemon is already running:

```bash
kspec serve status
```

If a daemon is already running and healthy, you may not need to start another one. If you need to restart it, stop the existing one first:

```bash
kspec serve stop
kspec serve start
```

If `kspec serve stop` does not resolve the issue (for example, if a non-kspec process holds the port), find out what is using the port:

```bash
lsof -i :3456
```

This shows the process ID of whatever is bound to port 3456. If it's a stale kspec process, you can terminate it:

```bash
kill <pid>
```

Replace `<pid>` with the process ID from the `lsof` output. Then start the daemon again:

```bash
kspec serve start
```

## Verification

After starting the daemon, confirm it's running:

```bash
kspec serve status
```

A healthy outcome shows the daemon running and listening on its port. You can also verify with a direct health check:

```bash
curl http://localhost:3456/api/health
```

A successful response confirms the daemon is up and serving requests.
