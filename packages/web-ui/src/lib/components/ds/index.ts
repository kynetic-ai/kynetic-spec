/**
 * Design-system component library.
 *
 * Shared, view-agnostic building blocks that draw from the design-token
 * substrate (`$lib/ds/*`). Entity views compose these instead of re-forking
 * header layout and status rendering.
 */
export { default as ViewHeader, type ViewHeaderCount } from "./ViewHeader.svelte";
export { default as StatusBadge } from "./StatusBadge.svelte";
export { default as ActorDisplay } from "./ActorDisplay.svelte";
