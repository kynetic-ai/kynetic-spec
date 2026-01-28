<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { fetchTasks } from '$lib/api';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';

	// AC: @web-dashboard ac-1, ac-2, ac-3
	// Task counts by status
	interface TaskCounts {
		ready: number;
		in_progress: number;
		pending_review: number;
		blocked: number;
		completed: number;
	}

	let counts = $state<TaskCounts>({
		ready: 0,
		in_progress: 0,
		pending_review: 0,
		blocked: 0,
		completed: 0
	});

	let loading = $state(true);

	onMount(async () => {
		await loadCounts();
	});

	async function loadCounts() {
		try {
			// Fetch all tasks to compute counts
			const response = await fetchTasks({ limit: 1000 });
			const tasks = response.items;

			// Compute counts
			const newCounts: TaskCounts = {
				ready: 0,
				in_progress: 0,
				pending_review: 0,
				blocked: 0,
				completed: 0
			};

			// Build a set of completed task refs for dependency checking
			const completedRefs = new Set(
				tasks
					.filter((t) => t.status === 'completed')
					.flatMap((t) => [t._ulid, ...(t.slugs || [])])
			);

			for (const task of tasks) {
				if (task.status === 'completed') {
					newCounts.completed++;
				} else if (task.status === 'in_progress') {
					newCounts.in_progress++;
				} else if (task.status === 'pending_review') {
					newCounts.pending_review++;
				} else if (task.status === 'blocked') {
					newCounts.blocked++;
				} else if (task.status === 'pending') {
					// Check if blocked by dependencies
					const deps = task.depends_on || [];
					const hasUnmetDeps = deps.some((dep) => {
						// Remove @ prefix if present
						const ref = dep.startsWith('@') ? dep.slice(1) : dep;
						return !completedRefs.has(ref);
					});
					if (hasUnmetDeps) {
						newCounts.blocked++;
					} else {
						newCounts.ready++;
					}
				}
			}

			counts = newCounts;
		} catch (err) {
			console.error('Failed to load task counts:', err);
		} finally {
			loading = false;
		}
	}

	// AC: @web-dashboard ac-3
	function navigateToTasks(status: string) {
		goto(`/tasks?status=${status}`);
	}

	// Status display config
	const statusConfig = [
		{ key: 'ready', label: 'Ready', color: 'bg-green-500', filterStatus: 'pending' },
		{ key: 'in_progress', label: 'In Progress', color: 'bg-blue-500', filterStatus: 'in_progress' },
		{
			key: 'pending_review',
			label: 'Pending Review',
			color: 'bg-yellow-500',
			filterStatus: 'pending_review'
		},
		{ key: 'blocked', label: 'Blocked', color: 'bg-red-500', filterStatus: 'blocked' },
		{ key: 'completed', label: 'Completed', color: 'bg-gray-500', filterStatus: 'completed' }
	] as const;
</script>

<div class="flex flex-col gap-6">
	<h1 class="text-3xl font-bold">Dashboard</h1>

	<!-- AC: @web-dashboard ac-1 - Task counts by status -->
	<div class="grid gap-4 md:grid-cols-3 lg:grid-cols-5" data-testid="dashboard-counts">
		{#each statusConfig as status}
			<button
				class="text-left"
				onclick={() => navigateToTasks(status.filterStatus)}
				data-testid="task-count-{status.key}"
			>
				<Card class="transition-colors hover:bg-muted/50 cursor-pointer">
					<CardHeader class="flex flex-row items-center justify-between pb-2 space-y-0">
						<CardTitle class="text-sm font-medium">{status.label}</CardTitle>
						<Badge class={status.color}>&nbsp;</Badge>
					</CardHeader>
					<CardContent>
						<div class="text-2xl font-bold">
							{#if loading}
								<span class="animate-pulse">...</span>
							{:else}
								{counts[status.key]}
							{/if}
						</div>
					</CardContent>
				</Card>
			</button>
		{/each}
	</div>
</div>
