<script lang="ts">
	/**
	 * ProjectSelector
	 *
	 * Dropdown to select active project when multiple projects are registered.
	 *
	 * AC Coverage:
	 * - ac-25 (@multi-directory-daemon): Shown when >1 project registered
	 * - ac-26 (@multi-directory-daemon): Selection triggers header change
	 * - ac-27 (@multi-directory-daemon): Selection triggers data reload
	 */
	import {
		Select,
		SelectContent,
		SelectItem,
		SelectTrigger
	} from '$lib/components/ui/select';
	import {
		getProjects,
		getSelectedProjectPath,
		selectProject,
		isLoading as isProjectLoading
	} from '$lib/stores/project.svelte';
	import { reconnectWithProject } from '$lib/stores/connection.svelte';
	import FolderIcon from '@lucide/svelte/icons/folder';

	// Derive display name from path (last segment)
	function getProjectName(path: string): string {
		const segments = path.split('/').filter(Boolean);
		return segments[segments.length - 1] || path;
	}

	// Handle project selection
	function handleSelect(value: string | undefined) {
		if (!value) return;

		// AC: @multi-directory-daemon ac-26, ac-27
		selectProject(value);

		// Reconnect WebSocket with new project
		reconnectWithProject(value);
	}

	// Get current selection for the select component
	let selectedValue = $derived(getSelectedProjectPath() ?? undefined);
	let projects = $derived(getProjects());
	let loading = $derived(isProjectLoading());
</script>

<!-- AC: @multi-directory-daemon ac-25 - Project selector component -->
<div class="w-full" data-testid="project-selector-container">
	{#if loading}
		<div
			class="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
			data-testid="loading-indicator"
		>
			<span class="animate-pulse">Loading projects...</span>
		</div>
	{:else}
		<Select type="single" value={selectedValue} onValueChange={handleSelect}>
			<SelectTrigger
				class="w-full"
				data-testid="project-selector"
				aria-label="Select project"
			>
				<div class="flex items-center gap-2 truncate">
					<FolderIcon class="size-4 shrink-0" />
					<span class="truncate">
						{selectedValue ? getProjectName(selectedValue) : 'Select project'}
					</span>
				</div>
			</SelectTrigger>
			<SelectContent>
				{#each projects as project (project.path)}
					<SelectItem value={project.path} label={getProjectName(project.path)}>
						<div class="flex flex-col">
							<span>{getProjectName(project.path)}</span>
							<span class="text-xs text-muted-foreground truncate" title={project.path}>
								{project.path}
							</span>
						</div>
					</SelectItem>
				{/each}
			</SelectContent>
		</Select>
	{/if}
</div>
