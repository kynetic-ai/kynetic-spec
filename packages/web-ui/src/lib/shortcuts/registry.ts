/**
 * The central keyboard shortcut registry.
 *
 * One registry owns every interface shortcut: it resolves chords per platform,
 * detects collisions within a context, refuses browser-reserved combinations
 * (falling through to declared fallbacks), dispatches exactly-once on keydown,
 * suppresses modifier-less chords inside text-entry controls, and enumerates
 * its active bindings.
 *
 * The class is plain TypeScript (no Svelte runes) so its behavior is directly
 * unit-testable. Reactive consumers subscribe via subscribe().
 *
 * AC: @ui-shortcut-registry ac-1, ac-2, ac-3, ac-4, ac-5, ac-6
 * AC: @web-shell-platform-target ac-3
 */

import {
  chordKey,
  eventToResolvedChord,
  hasPrimaryModifier,
  labelForChord,
  resolveChord,
} from "./chord.js";
import { isReserved } from "./reserved.js";
import {
  GLOBAL_CONTEXT,
  type ActiveBinding,
  type Platform,
  type RegisterResult,
  type ResolvedChord,
  type ShortcutDefinition,
  type UnboundShortcut,
} from "./types.js";

interface InternalBinding {
  def: ShortcutDefinition;
  context: string;
  chord: ResolvedChord;
  chordLabel: string;
  usedFallback: boolean;
}

/** Whether an event target is a text-entry control that should receive raw keys. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") {
    return false;
  }
  const el = target as HTMLElement;
  const tag = el.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
}

export class ShortcutRegistry {
  readonly #platform: Platform;
  /** Active contexts. The global context is always active. */
  readonly #activeContexts = new Set<string>([GLOBAL_CONTEXT]);
  /** context -> (chordKey -> binding). Holds bindings even while a context is inactive. */
  readonly #bindings = new Map<string, Map<string, InternalBinding>>();
  /** Shortcuts that resolved to no bindable chord. */
  readonly #unbound = new Map<string, UnboundShortcut>();
  /** Change subscribers for reactive consumers (e.g. shortcut-help, palette). */
  readonly #listeners = new Set<() => void>();

  constructor(platform: Platform) {
    this.#platform = platform;
  }

  get platform(): Platform {
    return this.#platform;
  }

  #contextMap(context: string): Map<string, InternalBinding> {
    let map = this.#bindings.get(context);
    if (!map) {
      map = new Map();
      this.#bindings.set(context, map);
    }
    return map;
  }

  #report(message: string): void {
    // The diagnostic surface for unbindable/colliding shortcuts — never silent.
    console.warn(`[shortcuts] ${message}`);
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  /**
   * Register a shortcut. Returns the outcome plus an unregister function for
   * component teardown.
   *
   * AC: @ui-shortcut-registry ac-4, ac-5
   */
  register(def: ShortcutDefinition): RegisterResult {
    const context = def.context ?? GLOBAL_CONTEXT;
    const map = this.#contextMap(context);
    const candidates = [def.chord, ...(def.fallbacks ?? [])];

    let chosen: ResolvedChord | null = null;
    let usedFallback = false;

    for (let i = 0; i < candidates.length; i++) {
      const resolved = resolveChord(candidates[i], this.#platform);
      const key = chordKey(resolved);
      const reservedHere = isReserved(resolved, this.#platform);
      const colliding = map.has(key);

      if (i === 0) {
        // Preferred chord: a reserved chord falls through to fallbacks, but a
        // collision is rejected outright (the existing binding is kept).
        if (reservedHere) {
          continue;
        }
        if (colliding) {
          const existing = map.get(key)!;
          this.#report(
            `collision: "${def.id}" wants ${labelForChord(resolved, this.#platform)} in context "${context}", already bound by "${existing.def.id}" — registration rejected`,
          );
          return {
            status: "collision",
            conflictId: existing.def.id,
            chord: resolved,
            unregister: () => {},
          };
        }
        chosen = resolved;
        usedFallback = false;
        break;
      }

      // Fallback chord: skip anything reserved or already bound.
      if (reservedHere || colliding) {
        continue;
      }
      chosen = resolved;
      usedFallback = true;
      break;
    }

    if (!chosen) {
      const shortcut: UnboundShortcut = {
        id: def.id,
        label: def.label,
        context,
        reason: "reserved-no-fallback",
      };
      this.#unbound.set(def.id, shortcut);
      this.#report(
        `unbound: "${def.id}" has no resolvable chord (preferred reserved, no free fallback) — reported, not dropped`,
      );
      this.#notify();
      return {
        status: "unbound",
        shortcut,
        unregister: () => {
          if (this.#unbound.delete(def.id)) {
            this.#notify();
          }
        },
      };
    }

    const binding: InternalBinding = {
      def,
      context,
      chord: chosen,
      chordLabel: labelForChord(chosen, this.#platform),
      usedFallback,
    };
    const boundKey = chordKey(chosen);
    map.set(boundKey, binding);
    this.#notify();

    return {
      status: "bound",
      binding: toActiveBinding(binding),
      unregister: () => {
        const ctxMap = this.#bindings.get(context);
        if (ctxMap && ctxMap.get(boundKey) === binding) {
          ctxMap.delete(boundKey);
          this.#notify();
        }
      },
    };
  }

  /** Mark a surface-scoped context active (its bindings become dispatchable). */
  activateContext(context: string): void {
    if (!this.#activeContexts.has(context)) {
      this.#activeContexts.add(context);
      this.#notify();
    }
  }

  /** Mark a surface-scoped context inactive. The global context cannot be deactivated. */
  deactivateContext(context: string): void {
    if (context === GLOBAL_CONTEXT) {
      return;
    }
    if (this.#activeContexts.delete(context)) {
      this.#notify();
    }
  }

  isContextActive(context: string): boolean {
    return this.#activeContexts.has(context);
  }

  /**
   * Dispatch a keydown event to at most one active binding.
   *
   * AC: @ui-shortcut-registry ac-1 (exactly once), ac-6 (text-entry suppression)
   */
  handleKeydown(event: KeyboardEvent): void {
    // Modifier-less chords (no platform primary modifier) must reach text-entry
    // controls untouched.
    if (!hasPrimaryModifier(event, this.#platform) && isTextEntryTarget(event.target)) {
      return;
    }

    const key = chordKey(eventToResolvedChord(event));
    const binding = this.#findActiveBinding(key);
    if (!binding) {
      return;
    }

    if (binding.def.preventDefault !== false) {
      event.preventDefault();
    }
    binding.def.handler(event);
  }

  /**
   * Find the single binding for a chord among active contexts. Surface-scoped
   * contexts take precedence over the global context, guaranteeing one match.
   */
  #findActiveBinding(key: string): InternalBinding | null {
    for (const context of this.#activeContexts) {
      if (context === GLOBAL_CONTEXT) {
        continue;
      }
      const binding = this.#bindings.get(context)?.get(key);
      if (binding) {
        return binding;
      }
    }
    return this.#bindings.get(GLOBAL_CONTEXT)?.get(key) ?? null;
  }

  /**
   * Enumerate every binding active in the current contexts with its display
   * label and the chord resolved for the active platform.
   *
   * AC: @ui-shortcut-registry ac-2
   */
  list(): ActiveBinding[] {
    const out: ActiveBinding[] = [];
    for (const context of this.#activeContexts) {
      const map = this.#bindings.get(context);
      if (!map) {
        continue;
      }
      for (const binding of map.values()) {
        out.push(toActiveBinding(binding));
      }
    }
    return out;
  }

  /** Shortcuts reported as unbound (no resolvable chord). */
  unbound(): UnboundShortcut[] {
    return [...this.#unbound.values()];
  }

  /** Subscribe to inventory changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

function toActiveBinding(binding: InternalBinding): ActiveBinding {
  return {
    id: binding.def.id,
    label: binding.def.label,
    context: binding.context,
    chord: { ...binding.chord },
    chordLabel: binding.chordLabel,
    usedFallback: binding.usedFallback,
  };
}
