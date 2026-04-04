/**
 * Patched createQuery / createInfiniteQuery wrappers.
 *
 * Works around a reactivity bug in @tanstack/svelte-query 6.1.x where
 * the observer subscription is set up inside $effect() (deferred), causing
 * the query state transition (isLoading → false) to be missed on fresh
 * page loads when data arrives before the $effect runs.
 *
 * Fix: use QueryObserver directly with synchronous subscription during
 * component init. Results are stored in a $state object and updated
 * property-by-property so Svelte's fine-grained reactivity tracks each
 * field natively without Proxy indirection.
 *
 * Remove this file once @tanstack/svelte-query ships the upstream fix
 * (PR #9810 or equivalent) and the project upgrades.
 */

import { onDestroy, untrack } from 'svelte';
import {
	QueryObserver,
	InfiniteQueryObserver,
} from '@tanstack/query-core';
import { useQueryClient } from '@tanstack/svelte-query';
import type {
	CreateQueryOptions,
	CreateQueryResult,
	CreateInfiniteQueryOptions,
	CreateInfiniteQueryResult,
	Accessor,
} from '@tanstack/svelte-query';
import type {
	QueryClient,
	QueryKey,
	DefaultError,
	InfiniteData,
} from '@tanstack/query-core';

// ---------------------------------------------------------------------------
// Internal: create a reactive query result from an observer
// ---------------------------------------------------------------------------

function createReactiveQuery(
	options: Accessor<Record<string, unknown>>,
	ObserverClass: typeof QueryObserver,
	queryClient?: Accessor<QueryClient>,
): Record<string, unknown> {
	const client = useQueryClient(queryClient?.());

	// Resolve options with client defaults
	function resolveOptions() {
		const opts = client.defaultQueryOptions(
			options() as Parameters<typeof client.defaultQueryOptions>[0],
		);
		opts._optimisticResults = 'optimistic';
		return opts;
	}

	const resolved = resolveOptions();

	// Create observer
	const observer = new ObserverClass(client, resolved);

	// Get the current optimistic result from the observer
	function getResult(): Record<string, unknown> {
		// Use untrack to avoid establishing reactive dependencies when reading
		// options inside the subscription callback
		return untrack(() => {
			const opts = resolveOptions();
			const result = observer.getOptimisticResult(opts);
			return (!opts.notifyOnChangeProps
				? observer.trackResult(result)
				: result) as Record<string, unknown>;
		});
	}

	// Initialize $state with a snapshot of the initial result.
	// Svelte tracks reads/writes on $state object properties natively.
	const initial = getResult();
	const result = $state<Record<string, unknown>>({ ...initial });

	// Sync all properties from a new query result into the $state object.
	// Uses untrack to prevent triggering reactive effects during the write.
	function syncResult(newResult: Record<string, unknown>) {
		untrack(() => {
			const newKeys = Object.keys(newResult);
			for (const key of newKeys) {
				result[key] = newResult[key];
			}
			// Remove stale properties
			for (const key of Object.keys(result)) {
				if (!(key in newResult)) {
					delete result[key];
				}
			}
		});
	}

	// Subscribe synchronously — the key fix (not deferred via $effect).
	// This ensures the subscription is active before any fetch completes.
	const unsubscribe = observer.subscribe(() => {
		syncResult(getResult());
	});

	// Handle any state that changed between construction and subscription
	observer.updateResult();
	syncResult(getResult());

	// Update observer options reactively when they change.
	// This effect only updates the observer — result syncing happens
	// via the subscription callback, not inside this effect.
	$effect.pre(() => {
		// Read options() to establish Svelte dependency tracking
		const opts = client.defaultQueryOptions(
			options() as Parameters<typeof client.defaultQueryOptions>[0],
		);
		opts._optimisticResults = 'optimistic';
		untrack(() => {
			observer.setOptions(opts);
			// After setting options, the observer may fire the subscription
			// callback which will sync the result. But if not (e.g., enabled
			// changed from false to true), do an explicit sync.
			syncResult(getResult());
		});
	});

	// Cleanup
	try {
		onDestroy(() => {
			unsubscribe();
		});
	} catch {
		// May be called outside component context (SSR)
	}

	return result;
}

// ---------------------------------------------------------------------------
// Public API: drop-in replacements for @tanstack/svelte-query
// ---------------------------------------------------------------------------

export function createQuery<
	TQueryFnData = unknown,
	TError = DefaultError,
	TData = TQueryFnData,
	TQueryKey extends QueryKey = QueryKey,
>(
	options: Accessor<CreateQueryOptions<TQueryFnData, TError, TData, TQueryKey>>,
	queryClient?: Accessor<QueryClient>,
): CreateQueryResult<TData, TError> {
	return createReactiveQuery(
		options as Accessor<Record<string, unknown>>,
		QueryObserver,
		queryClient,
	) as CreateQueryResult<TData, TError>;
}

export function createInfiniteQuery<
	TQueryFnData,
	TError = DefaultError,
	TData = InfiniteData<TQueryFnData>,
	TQueryKey extends QueryKey = QueryKey,
	TPageParam = unknown,
>(
	options: Accessor<
		CreateInfiniteQueryOptions<
			TQueryFnData,
			TError,
			TData,
			TQueryKey,
			TPageParam
		>
	>,
	queryClient?: Accessor<QueryClient>,
): CreateInfiniteQueryResult<TData, TError> {
	return createReactiveQuery(
		options as Accessor<Record<string, unknown>>,
		InfiniteQueryObserver as unknown as typeof QueryObserver,
		queryClient,
	) as CreateInfiniteQueryResult<TData, TError>;
}
