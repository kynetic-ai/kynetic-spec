/**
 * Behavioral unit tests for the keyboard shortcut registry.
 *
 * These exercise the registry's observable behavior through its public API on
 * an explicit platform — no source inspection. The registry core is plain
 * TypeScript (no Svelte runes), so it runs directly in the node vitest env.
 *
 * Covers @ui-shortcut-registry ac-1..ac-6 and @web-shell-platform-target ac-3.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ShortcutRegistry,
  chordKey,
  isReserved,
  labelForChord,
  resolveChord,
  type Platform,
  type ResolvedChord,
} from "../../packages/web-ui/src/lib/shortcuts/index.js";

/** Build a KeyboardEvent-shaped object for dispatch tests. */
function keyEvent(init: {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}): KeyboardEvent {
  const preventDefault = vi.fn<() => void>();
  return {
    key: init.key,
    metaKey: Boolean(init.meta),
    ctrlKey: Boolean(init.ctrl),
    altKey: Boolean(init.alt),
    shiftKey: Boolean(init.shift),
    target: init.target ?? null,
    preventDefault,
  } as unknown as KeyboardEvent;
}

const PLATFORMS: Platform[] = ["mac", "other"];

describe("shortcut registry — platform resolution (ac-3)", () => {
  // AC: @ui-shortcut-registry ac-3
  it.each([
    { platform: "mac" as Platform, meta: true, ctrl: false, label: "⌘K" },
    { platform: "other" as Platform, meta: false, ctrl: true, label: "Ctrl+K" },
  ])(
    "resolves the platform-abstract primary modifier on $platform",
    ({ platform, meta, ctrl, label }) => {
      const resolved = resolveChord({ mod: true, key: "k" }, platform);
      expect(resolved.meta).toBe(meta);
      expect(resolved.ctrl).toBe(ctrl);
      expect(labelForChord(resolved, platform)).toBe(label);
    },
  );

  // AC: @ui-shortcut-registry ac-3
  it("renders the chord label of the binding that is actually active", () => {
    for (const platform of PLATFORMS) {
      const registry = new ShortcutRegistry(platform);
      const result = registry.register({
        id: "palette",
        label: "Open palette",
        chord: { mod: true, key: "k" },
        handler: () => {},
      });
      expect(result.status).toBe("bound");
      if (result.status !== "bound") return;
      expect(result.binding.chordLabel).toBe(platform === "mac" ? "⌘K" : "Ctrl+K");
    }
  });

  // AC: @ui-shortcut-registry ac-3
  it("normalizes key case so chord identity is case-insensitive", () => {
    const a = resolveChord({ mod: true, key: "K" }, "mac");
    const b = resolveChord({ mod: true, key: "k" }, "mac");
    expect(chordKey(a)).toBe(chordKey(b));
  });
});

describe("shortcut registry — dispatch fires exactly once (ac-1)", () => {
  // AC: @ui-shortcut-registry ac-1
  it.each(PLATFORMS)("fires the bound action exactly once on %s", (platform) => {
    const registry = new ShortcutRegistry(platform);
    const handler = vi.fn<() => void>();
    registry.register({
      id: "palette",
      label: "Open palette",
      chord: { mod: true, key: "k" },
      handler,
    });

    const event = keyEvent({ key: "k", meta: platform === "mac", ctrl: platform === "other" });
    registry.handleKeydown(event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  // AC: @ui-shortcut-registry ac-1
  it("does not fire when a non-matching chord is pressed", () => {
    const registry = new ShortcutRegistry("other");
    const handler = vi.fn<() => void>();
    registry.register({
      id: "palette",
      label: "Open palette",
      chord: { mod: true, key: "k" },
      handler,
    });

    registry.handleKeydown(keyEvent({ key: "j", ctrl: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  // AC: @ui-shortcut-registry ac-1
  it("fires only one binding when a surface chord shadows a global chord", () => {
    const registry = new ShortcutRegistry("other");
    const globalHandler = vi.fn<() => void>();
    const surfaceHandler = vi.fn<() => void>();
    registry.register({
      id: "global.x",
      label: "Global X",
      chord: { ctrl: true, key: "x" },
      handler: globalHandler,
    });
    registry.activateContext("surface");
    registry.register({
      id: "surface.x",
      label: "Surface X",
      context: "surface",
      chord: { ctrl: true, key: "x" },
      handler: surfaceHandler,
    });

    registry.handleKeydown(keyEvent({ key: "x", ctrl: true }));
    expect(surfaceHandler).toHaveBeenCalledTimes(1);
    expect(globalHandler).not.toHaveBeenCalled();
  });

  // AC: @ui-shortcut-registry ac-1
  it("does not dispatch bindings whose context is inactive", () => {
    const registry = new ShortcutRegistry("other");
    const handler = vi.fn<() => void>();
    // Context never activated.
    registry.register({
      id: "triage.next",
      label: "Next",
      context: "triage",
      chord: { key: "ArrowRight" },
      handler,
    });
    registry.handleKeydown(keyEvent({ key: "ArrowRight" }));
    expect(handler).not.toHaveBeenCalled();

    registry.activateContext("triage");
    registry.handleKeydown(keyEvent({ key: "ArrowRight" }));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("shortcut registry — enumeration (ac-2)", () => {
  // AC: @ui-shortcut-registry ac-2
  it.each(PLATFORMS)(
    "enumerates active bindings with label and resolved chord on %s",
    (platform) => {
      const registry = new ShortcutRegistry(platform);
      registry.register({
        id: "palette",
        label: "Open palette",
        chord: { mod: true, key: "k" },
        handler: () => {},
      });
      registry.register({
        id: "sidebar",
        label: "Toggle sidebar",
        chord: { mod: true, key: "b" },
        handler: () => {},
      });

      const inventory = registry.list();
      expect(inventory).toHaveLength(2);
      const palette = inventory.find((b) => b.id === "palette");
      expect(palette?.label).toBe("Open palette");
      expect(palette?.chordLabel).toBe(platform === "mac" ? "⌘K" : "Ctrl+K");
      expect(palette?.chord.key).toBe("k");
    },
  );

  // AC: @ui-shortcut-registry ac-2
  it("only enumerates bindings whose context is currently active", () => {
    const registry = new ShortcutRegistry("other");
    registry.register({
      id: "global",
      label: "Global",
      chord: { ctrl: true, key: "g" },
      handler: () => {},
    });
    registry.register({
      id: "triage.next",
      label: "Next",
      context: "triage",
      chord: { key: "ArrowRight" },
      handler: () => {},
    });

    expect(registry.list().map((b) => b.id)).toEqual(["global"]);

    registry.activateContext("triage");
    expect(
      registry
        .list()
        .map((b) => b.id)
        .toSorted(),
    ).toEqual(["global", "triage.next"]);

    registry.deactivateContext("triage");
    expect(registry.list().map((b) => b.id)).toEqual(["global"]);
  });
});

describe("shortcut registry — collision rejection (ac-4)", () => {
  // AC: @ui-shortcut-registry ac-4
  it("rejects a colliding registration and keeps the existing binding", () => {
    const registry = new ShortcutRegistry("other");
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    registry.register({
      id: "first",
      label: "First",
      chord: { ctrl: true, key: "k" },
      handler: first,
    });

    const result = registry.register({
      id: "second",
      label: "Second",
      chord: { ctrl: true, key: "k" },
      handler: second,
    });
    expect(result.status).toBe("collision");
    if (result.status === "collision") {
      expect(result.conflictId).toBe("first");
    }

    // Only the original binding remains, and only its handler fires.
    const inventory = registry.list().filter((b) => b.chord.key === "k");
    expect(inventory).toHaveLength(1);
    expect(inventory[0].id).toBe("first");

    registry.handleKeydown(keyEvent({ key: "k", ctrl: true }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  // AC: @ui-shortcut-registry ac-4
  it("does not treat the same chord in a different context as a collision", () => {
    const registry = new ShortcutRegistry("other");
    registry.register({
      id: "global.k",
      label: "Global",
      chord: { ctrl: true, key: "k" },
      handler: () => {},
    });
    registry.activateContext("surface");
    const result = registry.register({
      id: "surface.k",
      label: "Surface",
      context: "surface",
      chord: { ctrl: true, key: "k" },
      handler: () => {},
    });
    expect(result.status).toBe("bound");
  });
});

describe("shortcut registry — reserved combinations and fallback (ac-5, web-shell-platform-target ac-3)", () => {
  // AC: @ui-shortcut-registry ac-5
  // AC: @web-shell-platform-target ac-3
  it.each(PLATFORMS)(
    "treats the platform primary modifier + W/T/N as reserved on %s",
    (platform) => {
      for (const key of ["w", "t", "n"]) {
        expect(isReserved(resolveChord({ mod: true, key }, platform), platform)).toBe(true);
      }
      // A normal app chord is not reserved.
      expect(isReserved(resolveChord({ mod: true, key: "k" }, platform), platform)).toBe(false);
    },
  );

  // AC: @web-shell-platform-target ac-3
  it("reserves Cmd+Q on macOS but not on other platforms", () => {
    expect(isReserved(resolveChord({ mod: true, key: "q" }, "mac"), "mac")).toBe(true);
    expect(isReserved(resolveChord({ mod: true, key: "q" }, "other"), "other")).toBe(false);
  });

  // AC: @ui-shortcut-registry ac-5
  it.each(PLATFORMS)("binds the first non-reserved, non-colliding fallback on %s", (platform) => {
    const registry = new ShortcutRegistry(platform);
    const handler = vi.fn<() => void>();
    // Preferred mod+w is reserved; first fallback mod+t is also reserved; mod+j is free.
    const result = registry.register({
      id: "feature",
      label: "Feature",
      chord: { mod: true, key: "w" },
      fallbacks: [
        { mod: true, key: "t" },
        { mod: true, key: "j" },
      ],
      handler,
    });

    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;
    expect(result.binding.chord.key).toBe("j");
    expect(result.binding.usedFallback).toBe(true);

    registry.handleKeydown(
      keyEvent({ key: "j", meta: platform === "mac", ctrl: platform === "other" }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // AC: @ui-shortcut-registry ac-5
  it("skips a fallback that collides with an existing binding", () => {
    const registry = new ShortcutRegistry("other");
    registry.register({
      id: "occupier",
      label: "Occupier",
      chord: { ctrl: true, key: "j" },
      handler: () => {},
    });

    const result = registry.register({
      id: "feature",
      label: "Feature",
      chord: { mod: true, key: "w" }, // reserved
      fallbacks: [
        { mod: true, key: "j" }, // collides with occupier
        { mod: true, key: "y" }, // free
      ],
      handler: () => {},
    });
    expect(result.status).toBe("bound");
    if (result.status === "bound") {
      expect(result.binding.chord.key).toBe("y");
    }
  });

  // AC: @ui-shortcut-registry ac-5
  it("reports a shortcut with no resolvable chord as unbound rather than dropping it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ShortcutRegistry("other");
      const result = registry.register({
        id: "doomed",
        label: "Doomed",
        chord: { mod: true, key: "w" }, // reserved
        fallbacks: [{ mod: true, key: "t" }], // also reserved
        handler: () => {},
      });

      expect(result.status).toBe("unbound");
      if (result.status === "unbound") {
        expect(result.shortcut.id).toBe("doomed");
        expect(result.shortcut.reason).toBe("reserved-no-fallback");
      }
      // Reported on the diagnostic surface, not silently dropped.
      expect(warn).toHaveBeenCalled();
      expect(registry.unbound().map((s) => s.id)).toContain("doomed");
      // Not an active binding.
      expect(registry.list().some((b) => b.id === "doomed")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("shortcut registry — text-entry suppression (ac-6)", () => {
  let registry: ShortcutRegistry;
  let arrowHandler: ReturnType<typeof vi.fn>;
  let modHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ShortcutRegistry("other");
    arrowHandler = vi.fn<() => void>();
    modHandler = vi.fn<() => void>();
    registry.register({
      id: "nav",
      label: "Nav",
      chord: { key: "ArrowRight" },
      handler: arrowHandler,
    });
    registry.register({
      id: "palette",
      label: "Palette",
      chord: { mod: true, key: "k" },
      handler: modHandler,
    });
  });

  // AC: @ui-shortcut-registry ac-6
  it.each([
    { tagName: "INPUT" },
    { tagName: "TEXTAREA" },
    { tagName: "DIV", isContentEditable: true },
  ])("suppresses a modifier-less chord while focus is in %o", (target) => {
    const event = keyEvent({ key: "ArrowRight", target });
    registry.handleKeydown(event);
    expect(arrowHandler).not.toHaveBeenCalled();
    // The keystroke is left for the control — default is not prevented.
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  // AC: @ui-shortcut-registry ac-6
  it("still fires a modifier-less chord outside text-entry controls", () => {
    registry.handleKeydown(keyEvent({ key: "ArrowRight", target: { tagName: "BUTTON" } }));
    expect(arrowHandler).toHaveBeenCalledTimes(1);
  });

  // AC: @ui-shortcut-registry ac-6
  it("still fires a primary-modifier chord even inside a text-entry control", () => {
    registry.handleKeydown(keyEvent({ key: "k", ctrl: true, target: { tagName: "INPUT" } }));
    expect(modHandler).toHaveBeenCalledTimes(1);
  });
});

describe("shortcut registry — teardown and reactivity", () => {
  // AC: @ui-shortcut-registry ac-1
  it("stops dispatching after a binding is unregistered", () => {
    const registry = new ShortcutRegistry("other");
    const handler = vi.fn<() => void>();
    const result = registry.register({
      id: "x",
      label: "X",
      chord: { ctrl: true, key: "x" },
      handler,
    });
    result.unregister();

    registry.handleKeydown(keyEvent({ key: "x", ctrl: true }));
    expect(handler).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(0);
  });

  // AC: @ui-shortcut-registry ac-2
  it("notifies subscribers when the inventory changes", () => {
    const registry = new ShortcutRegistry("other");
    const listener = vi.fn<() => void>();
    const unsubscribe = registry.subscribe(listener);

    const result = registry.register({
      id: "x",
      label: "X",
      chord: { ctrl: true, key: "x" },
      handler: () => {},
    });
    expect(listener).toHaveBeenCalledTimes(1);

    result.unregister();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registry.register({ id: "y", label: "Y", chord: { ctrl: true, key: "y" }, handler: () => {} });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("chordKey identity", () => {
  // AC: @ui-shortcut-registry ac-4
  it("produces equal keys for equal resolved chords and distinct keys otherwise", () => {
    const a: ResolvedChord = { key: "k", meta: false, ctrl: true, alt: false, shift: false };
    const b: ResolvedChord = { key: "k", meta: false, ctrl: true, alt: false, shift: false };
    const c: ResolvedChord = { key: "k", meta: true, ctrl: false, alt: false, shift: false };
    expect(chordKey(a)).toBe(chordKey(b));
    expect(chordKey(a)).not.toBe(chordKey(c));
  });
});
