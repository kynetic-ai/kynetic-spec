// AC: @ui-data-freshness ac-9 — Disable SSR globally.
// This app connects to a local daemon; SSR adds no value and causes
// hydration mismatches that break reactive state propagation on hard refresh.
export const ssr = false;
