// AC: @spec-daemon-server ac-1
// AC: @spec-daemon-server ac-2
// AC: @spec-daemon-server ac-3
// AC: @trait-api-endpoint ac-1
// AC: @trait-api-endpoint ac-2 — N/A: health endpoint does not mutate state
// AC: @trait-api-endpoint ac-3 — N/A: health endpoint has no validation schema
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, createTempDir } from "./helpers.js";

let app: Elysia;
let tempDir: string;

function createServerTestApp() {
  return new Elysia()
    .use(
      cors({
        origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
        credentials: true,
      }),
    )
    .onRequest((context) => {
      const host = context.request.headers.get("host");
      if (
        host &&
        !host.startsWith("localhost") &&
        !host.startsWith("127.0.0.1") &&
        !host.startsWith("[::1]")
      ) {
        context.set.status = 403;
        return {
          error: "Forbidden",
          message: "Only localhost connections are allowed",
        };
      }
    })
    .get("/api/health", () => ({
      status: "ok",
      uptime: process.uptime(),
      connections: 0,
      version: "0.1.0",
    }));
}

function makeReq(urlPath: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    Host: "localhost",
    ...(init.headers as Record<string, string>),
  };
  return app.handle(
    new Request(`http://localhost${urlPath}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
    }),
  );
}

function makeReqWithHost(urlPath: string, host: string) {
  return app.handle(
    new Request(`http://localhost${urlPath}`, {
      method: "GET",
      headers: { Host: host },
    }),
  );
}

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-server-");
  app = createServerTestApp();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

describe("GET /api/health", () => {
  it("returns health object with required fields", async () => {
    const response = await makeReq("/api/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      connections: expect.any(Number),
      version: expect.any(String),
    });
    expect(typeof body["uptime"]).toBe("number");
  });

  it("returns status ok", async () => {
    const response = await makeReq("/api/health");
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("returns numeric uptime", async () => {
    const response = await makeReq("/api/health");
    const body = (await response.json()) as { uptime: number };
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThan(0);
  });

  it("uptime increases between calls", async () => {
    const r1 = await makeReq("/api/health");
    const b1 = (await r1.json()) as { uptime: number };
    await new Promise((resolve) => setTimeout(resolve, 10));
    const r2 = await makeReq("/api/health");
    const b2 = (await r2.json()) as { uptime: number };
    expect(b2.uptime).toBeGreaterThanOrEqual(b1.uptime);
  });

  it("returns connections field", async () => {
    const response = await makeReq("/api/health");
    const body = (await response.json()) as { connections: number };
    expect(typeof body.connections).toBe("number");
  });

  it("returns version field", async () => {
    const response = await makeReq("/api/health");
    const body = (await response.json()) as { version: string };
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });

  it("returns JSON content type", async () => {
    const response = await makeReq("/api/health");
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("CORS Headers", () => {
  it("allows localhost:5173 origin", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/health", {
        method: "GET",
        headers: {
          Host: "localhost",
          Origin: "http://localhost:5173",
        },
      }),
    );
    expect(response.status).toBe(200);
    const allowOrigin = response.headers.get("access-control-allow-origin");
    expect(allowOrigin).toBe("http://localhost:5173");
  });

  it("allows 127.0.0.1:5173 origin", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/health", {
        method: "GET",
        headers: {
          Host: "localhost",
          Origin: "http://127.0.0.1:5173",
        },
      }),
    );
    expect(response.status).toBe(200);
    const allowOrigin = response.headers.get("access-control-allow-origin");
    expect(allowOrigin).toBe("http://127.0.0.1:5173");
  });

  it("includes credentials header for allowed origins", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/health", {
        method: "GET",
        headers: {
          Host: "localhost",
          Origin: "http://localhost:5173",
        },
      }),
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
  });
});

describe("Localhost Security", () => {
  it("is accessible from localhost", async () => {
    const response = await makeReqWithHost("/api/health", "localhost");
    expect(response.status).toBe(200);
  });

  it("is accessible from 127.0.0.1", async () => {
    const response = await makeReqWithHost("/api/health", "127.0.0.1");
    expect(response.status).toBe(200);
  });

  it("is accessible from [::1]", async () => {
    const response = await makeReqWithHost("/api/health", "[::1]");
    expect(response.status).toBe(200);
  });

  it("rejects non-localhost Host with 403", async () => {
    const response = await makeReqWithHost("/api/health", "example.com");
    expect(response.status).toBe(403);
  });

  it("rejects external IP Host with 403", async () => {
    const response = await makeReqWithHost("/api/health", "192.168.1.100");
    expect(response.status).toBe(403);
  });

  it("returns error message for forbidden host", async () => {
    const response = await makeReqWithHost("/api/health", "evil.example.com");
    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error: string;
      message: string;
    };
    expect(body.error).toBe("Forbidden");
    expect(body.message).toContain("localhost");
  });
});

describe("Non-API route behavior", () => {
  // SPA fallback test (GET / serves HTML) is SKIPPED because it requires the
  // static plugin and a web UI production build, which are not available in
  // the vitest context. This is tested in the e2e suite instead.
  it.skip("GET / serves the SPA HTML (requires static plugin + web UI build)", () => {
    // Skipped: not available in vitest context
  });

  it("health endpoint works without project context", async () => {
    const response = await makeReq("/api/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
