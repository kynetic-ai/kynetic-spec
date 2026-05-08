/**
 * Behavioral regression tests for `kspec agent dispatch watch` URL contract.
 *
 * The watch command opens a daemon WebSocket via `getRunningDaemonClient()`
 * and feeds the advertised `ws_url` to its WebSocket constructor verbatim.
 * Existing watch tests mock `PidFileManager.readPort()` so they exercise
 * the legacy-port fallback (`ws://127.0.0.1:<port>/ws`) — they would still
 * pass if the URL were re-derived from a port number alone. This file
 * seeds real `daemon.connection.json` metadata advertising a non-default
 * `ws_url` (loopback alias `127.0.0.2` or bracketed IPv6 `::1`) and asserts
 * the WebSocket constructor receives that exact URL.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
 * AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import {
  registerAgentCommands,
  _setWebSocketCtor,
} from "../src/cli/commands/agent.js";
import {
  cleanupTempDir,
  createIsolatedKspecHome,
  createTempDir,
  waitForStartup,
  type IsolatedKspecHome,
} from "./helpers/cli.js";
import {
  probeHostAvailable,
  writeMockDaemonMetadata,
  type MockDaemonClient,
} from "./helpers/mock-daemon.js";

interface FakeWsInstance {
  send: ReturnType<typeof vi.fn>;
  addEventListener: (event: string, handler: (...args: any[]) => void) => void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: (() => void) | null;
}

function makeUrlCapturingFakeWs(): {
  FakeWs: new (url: string) => FakeWsInstance;
  capturedUrls: string[];
  getLastInstance: () => FakeWsInstance | null;
} {
  const capturedUrls: string[] = [];
  let last: FakeWsInstance | null = null;
  class FakeWs implements FakeWsInstance {
    send = vi.fn();
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onclose: (() => void) | null = null;
    addEventListener(event: string, handler: (...args: any[]) => void): void {
      if (event === "open") this.onopen = handler;
      else if (event === "message") this.onmessage = handler as (e: { data: string }) => void;
      else if (event === "error") this.onerror = handler;
      else if (event === "close") this.onclose = handler as () => void;
    }
    constructor(url: string) {
      capturedUrls.push(url);
      // oxlint-disable-next-line typescript-eslint/no-this-alias -- intentional capture for tests
      last = this;
    }
  }
  return {
    FakeWs: FakeWs as new (url: string) => FakeWsInstance,
    capturedUrls,
    getLastInstance: () => last,
  };
}

function createTestProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerAgentCommands(program);
  return program;
}

/**
 * Build a synthetic MockDaemonClient that points at the desired host:port
 * without actually starting a server. The watch command never opens a real
 * WebSocket here (the test stubs the WS constructor); only the URL the
 * constructor receives matters. The synthetic client lets the canonical
 * metadata writer render snake_case fields and the proper bracket form.
 */
function fakeClient(host: string, port: number): MockDaemonClient {
  const formatted = host.includes(":") ? `[${host}]` : host;
  return {
    port,
    bindHost: host,
    apiUrl: `http://${formatted}:${port}`,
    wsUrl: `ws://${formatted}:${port}/ws`,
    requests: () => [],
    stop: async () => {},
  };
}

/**
 * initContext() is invoked by the watch action to resolve the project dir.
 * Mock it to throw immediately — the watch command catches and treats this
 * as non-fatal (the WebSocket simply uses the daemon default project), so
 * the constructor still runs and we can inspect the captured URL.
 */
async function mockInitContextFast(): Promise<void> {
  const parserModule = await import("../src/parser/index.js");
  vi.spyOn(parserModule, "initContext").mockRejectedValue(new Error("mocked"));
}

describe("`agent dispatch watch` opens the WebSocket at the metadata-advertised ws_url", () => {
  let tempDir: string;
  let home: IsolatedKspecHome;
  let originalHome: string | undefined;
  let originalNoDaemon: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-cli-agent-watch-");
    home = await createIsolatedKspecHome(tempDir);
    originalHome = process.env.HOME;
    originalNoDaemon = process.env.KSPEC_NO_DAEMON;
    process.env.HOME = home.homeDir;
    delete process.env.KSPEC_NO_DAEMON;
  });

  afterEach(async () => {
    _setWebSocketCtor(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env.HOME = originalHome!;
    if (originalNoDaemon === undefined) {
      delete process.env.KSPEC_NO_DAEMON;
    } else {
      process.env.KSPEC_NO_DAEMON = originalNoDaemon;
    }
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  //
  // Default loopback baseline: metadata advertises ws://127.0.0.1:<port>/ws
  // at a non-default port. Watch must open the WebSocket at that exact URL
  // — proving the URL came from `daemon.connection.json`, not from a
  // separately re-derived host or port.
  it("uses the advertised ws://127.0.0.1:<port>/ws verbatim", async () => {
    const advertisedPort = 41234;
    writeMockDaemonMetadata({
      home,
      client: fakeClient("127.0.0.1", advertisedPort),
    });

    await mockInitContextFast();
    const { FakeWs, capturedUrls, getLastInstance } = makeUrlCapturingFakeWs();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitForStartup(
      "watch WebSocket constructor invocation",
      async () => {
        const ok = capturedUrls.length > 0;
        return {
          ok,
          details: ok ? `captured: ${capturedUrls[0]}` : "no WebSocket created yet",
        };
      },
      { timeoutMs: 2_000, intervalMs: 10 },
    );

    expect(capturedUrls).toHaveLength(1);
    // URL must include the advertised port verbatim — re-deriving from a
    // port-only fallback at a different port would fail here.
    const captured = new URL(capturedUrls[0]);
    expect(captured.protocol).toBe("ws:");
    expect(captured.hostname).toBe("127.0.0.1");
    expect(captured.port).toBe(String(advertisedPort));
    expect(captured.pathname).toBe("/ws");

    // Close the fake WS to end the watch action's await.
    getLastInstance()?.onclose?.();
    runPromise.catch(() => {
      /* ignore */
    });
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  //
  // Strongest behavioral evidence: metadata advertises ws://127.0.0.2:<port>/ws.
  // A regression that re-derived ws://127.0.0.1:<port>/ws would fail this test
  // because the captured constructor URL has the wrong host. Linux routes
  // 127.0.0.2 to loopback; on platforms where it does not, we still assert
  // the URL the constructor saw — no socket binding needed.
  it("uses a non-default loopback alias ws://127.0.0.2:<port>/ws verbatim", async () => {
    const advertisedPort = 41235;
    writeMockDaemonMetadata({
      home,
      client: fakeClient("127.0.0.2", advertisedPort),
      bindHost: "0.0.0.0",
      connectHost: "127.0.0.2",
    });

    await mockInitContextFast();
    const { FakeWs, capturedUrls, getLastInstance } = makeUrlCapturingFakeWs();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitForStartup(
      "watch WebSocket constructor invocation (alias)",
      async () => {
        const ok = capturedUrls.length > 0;
        return {
          ok,
          details: ok ? `captured: ${capturedUrls[0]}` : "no WebSocket created yet",
        };
      },
      { timeoutMs: 2_000, intervalMs: 10 },
    );

    expect(capturedUrls).toHaveLength(1);
    const captured = new URL(capturedUrls[0]);
    expect(captured.protocol).toBe("ws:");
    // The host must match the advertised connect_host alias verbatim — a
    // regression that re-derived 127.0.0.1 would fail here.
    expect(captured.hostname).toBe("127.0.0.2");
    expect(captured.port).toBe(String(advertisedPort));
    expect(captured.pathname).toBe("/ws");

    getLastInstance()?.onclose?.();
    runPromise.catch(() => {
      /* ignore */
    });
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  //
  // When the daemon advertises an IPv6 fallback (`ws://[::1]:<port>/ws`),
  // watch must pass the bracketed URL through verbatim. Re-deriving from
  // bind_host alone would either lose the bracket syntax or pick a v4
  // host. URL parsing only — skip when IPv6 loopback is unreachable.
  it("uses a bracketed IPv6 ws://[::1]:<port>/ws verbatim", async () => {
    if (!(await probeHostAvailable("::1"))) {
      console.log("  ⊘ Skipping test - IPv6 loopback (::1) not available");
      return;
    }
    const advertisedPort = 41236;
    writeMockDaemonMetadata({
      home,
      client: fakeClient("::1", advertisedPort),
    });

    await mockInitContextFast();
    const { FakeWs, capturedUrls, getLastInstance } = makeUrlCapturingFakeWs();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitForStartup(
      "watch WebSocket constructor invocation (ipv6)",
      async () => {
        const ok = capturedUrls.length > 0;
        return {
          ok,
          details: ok ? `captured: ${capturedUrls[0]}` : "no WebSocket created yet",
        };
      },
      { timeoutMs: 2_000, intervalMs: 10 },
    );

    expect(capturedUrls).toHaveLength(1);
    // Assert on the raw URL string — node URL parsing of bracketed v6 may
    // strip brackets in `hostname` getters depending on platform, so we
    // verify the literal substring instead. The bracketed form proves the
    // URL came from metadata (brackets are constructed only at metadata
    // write time, not by string-formatting a port number).
    expect(capturedUrls[0]).toContain(`ws://[::1]:${advertisedPort}/ws`);

    getLastInstance()?.onclose?.();
    runPromise.catch(() => {
      /* ignore */
    });
  });
});
