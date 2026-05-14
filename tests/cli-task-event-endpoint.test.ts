/**
 * Behavioral regression tests for the CLI-side `postDispatchEvent` helper
 * in `src/cli/dispatch-events.ts`. The helper fires a fire-and-forget POST
 * to `/api/agent/events` whenever a task state transition is committed
 * locally — it is the only CLI-side surface that talks to the daemon's
 * dispatch event ingest endpoint, so it must honour the centralised
 * `getRunningDaemonClient()` URL contract instead of re-deriving the URL
 * from a port number alone.
 *
 * Stand up an in-process mock daemon via the shared
 * tests/helpers/mock-daemon.ts fixture on a non-default loopback (or
 * bracketed IPv6) host, write canonical daemon connection metadata
 * pointing at that endpoint, then call `postDispatchEvent` directly and
 * assert the recorded request uses the metadata-advertised URL — not
 * 127.0.0.1.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
 * AC: @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint
 * AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
 * AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
 * AC: @daemon-test-endpoint-consistency ac-mock-metadata-fidelity
 * AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
 * AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { postDispatchEvent } from "../src/cli/dispatch-events.js";
import {
  cleanupTempDir,
  createIsolatedKspecHome,
  createTempDir,
  type IsolatedKspecHome,
} from "./helpers/cli.js";
import {
  expectedHostHeader,
  probeHostAvailable,
  startMockDaemon,
  writeMockDaemonMetadata,
  type MockDaemonClient,
} from "./helpers/mock-daemon.js";

describe("postDispatchEvent posts /api/agent/events to the metadata-advertised api_url", () => {
  let tempDir: string;
  let home: IsolatedKspecHome;
  let originalHome: string | undefined;
  let originalNoDaemon: string | undefined;
  let originalSessionId: string | undefined;
  let mock: MockDaemonClient | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-cli-task-event-");
    home = await createIsolatedKspecHome(tempDir);
    originalHome = process.env.HOME;
    originalNoDaemon = process.env.KSPEC_NO_DAEMON;
    originalSessionId = process.env.KSPEC_SESSION_ID;
    process.env.HOME = home.homeDir;
    delete process.env.KSPEC_NO_DAEMON;
    // postDispatchEvent suppresses itself when KSPEC_SESSION_ID is set.
    delete process.env.KSPEC_SESSION_ID;
  });

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = undefined;
    }
    process.env.HOME = originalHome!;
    if (originalNoDaemon === undefined) {
      delete process.env.KSPEC_NO_DAEMON;
    } else {
      process.env.KSPEC_NO_DAEMON = originalNoDaemon;
    }
    if (originalSessionId === undefined) {
      delete process.env.KSPEC_SESSION_ID;
    } else {
      process.env.KSPEC_SESSION_ID = originalSessionId;
    }
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint
  // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
  // AC: @daemon-test-endpoint-consistency ac-mock-metadata-fidelity
  // AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  //
  // Default loopback baseline: metadata advertises 127.0.0.1 at an
  // ephemeral port. postDispatchEvent must POST /api/agent/events at that
  // exact endpoint, including the advertised port — proving the URL came
  // from metadata rather than a separate hardcoded `localhost`.
  it("posts /api/agent/events at the metadata-advertised 127.0.0.1 endpoint", async () => {
    mock = (await startMockDaemon()) ?? undefined;
    expect(mock).toBeDefined();
    writeMockDaemonMetadata({ home, client: mock! });

    await postDispatchEvent({
      taskId: "01TASKULIDFAKE0000000000000",
      taskRef: "@endpoint-event-task",
      fromStatus: "pending",
      toStatus: "in_progress",
      projectPath: home.homeDir,
    });

    const recorded = mock!.requests();
    expect(recorded).toHaveLength(1);
    const req = recorded[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/agent/events");
    expect(req.host).toBe(expectedHostHeader("127.0.0.1", mock!.port));

    const parsed = JSON.parse(req.body) as {
      task_id: string;
      task_ref: string;
      from_status: string;
      to_status: string;
    };
    expect(parsed.task_id).toBe("01TASKULIDFAKE0000000000000");
    expect(parsed.task_ref).toBe("@endpoint-event-task");
    expect(parsed.from_status).toBe("pending");
    expect(parsed.to_status).toBe("in_progress");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  // AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
  //
  // The metadata advertises a non-default loopback alias (127.0.0.2). On
  // Linux this address routes to loopback; on macOS / Windows it does not.
  // If postDispatchEvent re-derived `127.0.0.1`, the request would never
  // reach this server. The Host header is the strongest behavioural proof
  // that the URL came from metadata. Test skips when the alias is not
  // addressable.
  it("honors a non-default connect_host advertised by metadata", async () => {
    if (!(await probeHostAvailable("127.0.0.2"))) {
      console.log("  ⊘ Skipping test - 127.0.0.2 loopback alias not available");
      return;
    }
    mock = (await startMockDaemon({ bindHost: "127.0.0.2" })) ?? undefined;
    if (!mock) {
      console.log("  ⊘ Skipping test - mock daemon failed to start on 127.0.0.2");
      return;
    }

    // Advertise a wildcard bind with the alias as connect_host so the
    // metadata also exercises the wildcard-not-destination contract.
    writeMockDaemonMetadata({
      home,
      client: mock,
      bindHost: "0.0.0.0",
      connectHost: "127.0.0.2",
    });

    await postDispatchEvent({
      taskId: "01TASKULIDALIAS000000000000",
      taskRef: "@endpoint-alias-task",
      fromStatus: "in_progress",
      toStatus: "pending_review",
      projectPath: home.homeDir,
    });

    const recorded = mock.requests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe("/api/agent/events");
    // Host header reflects the URL the client actually called — a
    // request that hardcoded 127.0.0.1 would never reach this server.
    expect(recorded[0].host).toBe(expectedHostHeader("127.0.0.2", mock.port));
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  // AC: @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint
  //
  // When metadata advertises a bracketed IPv6 api_url, postDispatchEvent
  // must call that bracketed URL verbatim — re-derived URLs would corrupt
  // the bracket syntax or pick a different host entirely.
  it("honors a bracketed IPv6 api_url advertised by metadata", async () => {
    if (!(await probeHostAvailable("::1"))) {
      console.log("  ⊘ Skipping test - IPv6 loopback (::1) not available");
      return;
    }
    mock = (await startMockDaemon({ bindHost: "::1" })) ?? undefined;
    if (!mock) {
      console.log("  ⊘ Skipping test - IPv6 server failed to start");
      return;
    }

    writeMockDaemonMetadata({ home, client: mock });

    await postDispatchEvent({
      taskId: "01TASKULIDIPV6000000000000",
      taskRef: "@endpoint-ipv6-task",
      fromStatus: "pending",
      toStatus: "in_progress",
      projectPath: home.homeDir,
    });

    const recorded = mock.requests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe("/api/agent/events");
    // The Host header includes the bracketed IPv6 literal verbatim,
    // proving the client used the bracketed api_url from metadata
    // rather than re-deriving (which would corrupt the bracket syntax).
    expect(recorded[0].host).toBe(expectedHostHeader("::1", mock.port));
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  //
  // KSPEC_SESSION_ID short-circuits postDispatchEvent before any HTTP work
  // — verifies the suppression contract still holds even when metadata is
  // present (otherwise dispatched agents would emit redundant events that
  // accumulate in the queue).
  it("does not call the daemon when KSPEC_SESSION_ID is set (dispatched agent)", async () => {
    mock = (await startMockDaemon()) ?? undefined;
    expect(mock).toBeDefined();
    writeMockDaemonMetadata({ home, client: mock! });
    process.env.KSPEC_SESSION_ID = "01SESSIONFAKE0000000000000";

    await postDispatchEvent({
      taskId: "01TASKULIDSKIP000000000000",
      taskRef: "@endpoint-skip-task",
      fromStatus: "pending",
      toStatus: "in_progress",
      projectPath: home.homeDir,
    });

    expect(mock!.requests()).toHaveLength(0);
  });
});
