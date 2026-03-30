/**
 * Patched createQuery / createInfiniteQuery wrappers.
 *
 * Works around a timing bug in @tanstack/svelte-query 6.1.x where the
 * observer subscription is set up inside a Svelte 5 `$effect`. Because
 * `$effect` callbacks are deferred (they run after the component's
 * rendering micro-task), the subscription misses the observer's initial
 * state transition from `isLoading: true` to `isLoading: false` when
 * the fetch completes before the effect runs.
 *
 * Fix: subscribe eagerly (synchronously during component init) and use
 * `$effect.pre` via watchChanges for resubscription on dependency
 * changes. This matches the approach in TanStack/query PR #9810.
 *
 * Remove this file once @tanstack/svelte-query ships the upstream fix
 * (PR #9810 or equivalent) and the project upgrades.
 */

import { onDestroy, untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import {
	QueryObserver,
	InfiniteQueryObserver,
	type QueryClient,
	type QueryKey,
	type DefaultError,
	type InfiniteData,
} from '@tanstack/query-core';
import { useIsRestoring, useQueryClient } from '@tanstack/svelte-query';
import type {
	Accessor,
	CreateBaseQueryOptions,
	CreateBaseQueryResult,
	CreateQueryOptions,
	CreateQueryResult,
	DefinedCreateQueryResult,
	CreateInfiniteQueryOptions,
	CreateInfiniteQueryResult,
} from '@tanstack/svelte-query';

// ---------------------------------------------------------------------------
// Inlined from @tanstack/svelte-query internals (not publicly exported).
// Kept minimal — only the pieces needed by createBaseQuery.
// ---------------------------------------------------------------------------

const lazyBrand = Symbol('LazyValue');
type Branded<T extends () => unknown> = T & { [lazyBrand]: true };

function brand<T extends () => unknown>(fn: T): Branded<T> {
	// @ts-expect-error - branding
	fn[lazyBrand] = true;
	return fn as Branded<T>;
}

function isBranded<T extends () => unknown>(fn: T): fn is Branded<T> {
	return Boolean((fn as Branded<T>)[lazyBrand]);
}

function createRawRef<T extends {} | Array<unknown>>(
	init: T,
): [T, (newValue: T) => void] {
	const refObj = (Array.isArray(init) ? [] : {}) as T;
	const hiddenKeys = new SvelteSet<PropertyKey>();
	const out = new Proxy(refObj, {
		set(target, prop, value, receiver) {
			hiddenKeys.delete(prop);
			if (prop in target) {
				return Reflect.set(target, prop, value, receiver);
			}
			let state = $state.raw(value);
			Object.defineProperty(target, prop, {
				configurable: true,
				enumerable: true,
				get: () => {
					return state && isBranded(state) ? state() : state;
				},
				set: (v) => {
					state = v;
				},
			});
			return true;
		},
		has: (target, prop) => {
			if (hiddenKeys.has(prop)) return false;
			return prop in target;
		},
		ownKeys(target) {
			return Reflect.ownKeys(target).filter((key) => !hiddenKeys.has(key));
		},
		getOwnPropertyDescriptor(target, prop) {
			if (hiddenKeys.has(prop)) return undefined;
			return Reflect.getOwnPropertyDescriptor(target, prop);
		},
		deleteProperty(target, prop) {
			if (prop in target) {
				// @ts-expect-error - signaling deletion
				target[prop] = undefined;
				hiddenKeys.add(prop);
				if (Array.isArray(target)) target.length--;
				return true;
			}
			return false;
		},
	});

	function update(newValue: T) {
		const existingKeys = Object.keys(out);
		const newKeys = Object.keys(newValue);
		const keysToRemove = existingKeys.filter((key) => !newKeys.includes(key));
		for (const key of keysToRemove) {
			// @ts-expect-error - proxy handles it
			delete out[key];
		}
		for (const key of newKeys) {
			// @ts-expect-error - lazy brand wrapper to avoid eager property access tracking
			out[key] = brand(() => newValue[key]);
		}
	}

	update(init);
	return [out, update];
}

type Getter<T> = () => T;

function watchChanges<T>(
	sources: Getter<T> | Array<Getter<T>>,
	flush: 'post' | 'pre',
	effect: (
		values: T | Array<T>,
		previousValues: T | undefined | Array<T | undefined>,
	) => void | (() => void),
) {
	let active = false;
	let previousValues: T | undefined | Array<T | undefined> = Array.isArray(sources) ? [] : undefined;

	const run = () => {
		const values = Array.isArray(sources)
			? sources.map((source) => source())
			: sources();
		if (!active) {
			active = true;
			previousValues = values;
			return;
		}
		const cleanup = untrack(() => effect(values, previousValues));
		previousValues = values;
		return cleanup;
	};

	if (flush === 'pre') {
		$effect.pre(run);
	} else {
		$effect(run);
	}
}

// ---------------------------------------------------------------------------
// Patched createBaseQuery — eager subscription instead of deferred $effect
// ---------------------------------------------------------------------------

function createBaseQueryPatched<
	TQueryFnData,
	TError,
	TData,
	TQueryData,
	TQueryKey extends QueryKey,
>(
	options: Accessor<
		CreateBaseQueryOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>
	>,
	Observer: typeof QueryObserver,
	queryClient?: Accessor<QueryClient>,
): CreateBaseQueryResult<TData, TError> {
	const client = $derived(useQueryClient(queryClient?.()));
	const isRestoring = useIsRestoring();

	const resolvedOptions = $derived.by(() => {
		const opts = client.defaultQueryOptions(options());
		opts._optimisticResults = isRestoring.current ? 'isRestoring' : 'optimistic';
		return opts;
	});

	// svelte-ignore state_referenced_locally - intentional, initial value
	let observer = $state(
		new Observer<TQueryFnData, TError, TData, TQueryData, TQueryKey>(
			client,
			resolvedOptions,
		),
	);
	watchChanges(
		() => client,
		'pre',
		() => {
			observer = new Observer<TQueryFnData, TError, TData, TQueryData, TQueryKey>(
				client,
				resolvedOptions,
			);
		},
	);

	function createResult() {
		const result = observer.getOptimisticResult(resolvedOptions);
		return !resolvedOptions.notifyOnChangeProps
			? observer.trackResult(result)
			: result;
	}

	const [query, update] = createRawRef(
		// svelte-ignore state_referenced_locally - intentional, initial value
		createResult(),
	);

	// FIX: Subscribe eagerly (synchronously) instead of inside $effect.
	// This ensures the subscription is active before any async fetch completes,
	// preventing the race where observer.updateResult() finds no diff because
	// the observer already transitioned while no subscribers were attached.
	let unsubscribe =
		isRestoring.current && typeof window !== 'undefined'
			? () => undefined
			: observer.subscribe(() => update(createResult()));

	// Resubscribe when isRestoring or observer changes.
	watchChanges(
		() => [isRestoring.current, observer] as const,
		'pre',
		() => {
			unsubscribe();
			unsubscribe = isRestoring.current
				? () => undefined
				: observer.subscribe(() => update(createResult()));
			observer.updateResult();
			return () => unsubscribe();
		},
	);

	// Cleanup via onDestroy (runs on server too, unlike $effect.pre cleanup).
	try {
		onDestroy(() => {
			unsubscribe();
		});
	} catch {
		// May be called outside component context in edge cases
	}

	watchChanges(
		() => resolvedOptions,
		'pre',
		() => {
			observer.setOptions(resolvedOptions);
		},
	);

	watchChanges(
		() => [resolvedOptions, observer],
		'pre',
		() => {
			update(createResult());
		},
	);

	return query;
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
	return createBaseQueryPatched(options, QueryObserver, queryClient);
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
	return createBaseQueryPatched(
		options,
		InfiniteQueryObserver as typeof QueryObserver,
		queryClient,
	) as CreateInfiniteQueryResult<TData, TError>;
}
