<!--
  AC: @ui-settings-view ac-1 — Displays project config (name, version, remote tracking),
  conventions list from meta, daemon connection info (port, uptime, version), and shadow branch
  status. Read-only for v1.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { Convention } from '@kynetic-ai/shared';
	import {
		fetchHealth,
		fetchProjectConfig,
		fetchShadowStatus,
		fetchConventions,
		type HealthResponse,
		type ProjectConfig,
		type ShadowStatusResponse
	} from '$lib/api';
	import { getSnapshot, isStaticMode } from '$lib/stores/mode.svelte';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { getProjectVersion, isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import ServerIcon from '@lucide/svelte/icons/server';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	// ── Data state ──
	let health = $state<HealthResponse | null>(null);
	let projectConfig = $state<ProjectConfig | null>(null);
	let shadowStatus = $state<ShadowStatusResponse | null>(null);
	let conventions = $state<Convention[]>([]);

	let loadingConfig = $state(true);
	let loadingHealth = $state(true);
	let loadingShadow = $state(true);
	let loadingConventions = $state(true);

	let errorConfig = $state('');
	let errorHealth = $state('');
	let errorShadow = $state('');
	let errorConventions = $state('');

	// Convention expand state
	let expandedDomains = $state<Set<string>>(new Set());

	// ── Lifecycle ──
	onMount(() => {
		if (!isStaticMode()) {
			subscribe(['files:updates']);
			on('files:updates', handleUpdate);
		}
	});

	onDestroy(() => {
		if (!isStaticMode()) {
			off('files:updates', handleUpdate);
			unsubscribe(['files:updates']);
		}
	});

	// Load data when project is ready and reload on project change.
	// Gates on isProjectInitialized() to prevent loading with wrong/missing project context.
	$effect(() => {
		const version = getProjectVersion();
		const ready = isProjectInitialized();
		if (!ready) return;
		loadAllData();
	});

	// ── Data loading ──
	async function loadAllData() {
		await Promise.all([loadConfig(), loadHealth(), loadShadow(), loadConventions()]);
	}

	async function loadConfig() {
		if (isStaticMode()) {
			const snapshot = getSnapshot();
			projectConfig = {
				project: {
					name: snapshot?.project.name ?? 'Static Export',
					version: snapshot?.project.version ?? '—',
					status: 'static'
				},
				spec_version: null,
				root_dir: 'GitHub Pages export',
				remote_tracking: null,
				daemon: { port: 0, host: 'n/a', auto_start: false }
			};
			loadingConfig = false;
			return;
		}
		try {
			loadingConfig = true;
			errorConfig = '';
			projectConfig = await fetchProjectConfig();
		} catch (err) {
			errorConfig = err instanceof Error ? err.message : 'Failed to load project config';
		} finally {
			loadingConfig = false;
		}
	}

	async function loadHealth() {
		if (isStaticMode()) {
			loadingHealth = false;
			return;
		}
		try {
			loadingHealth = true;
			errorHealth = '';
			health = await fetchHealth();
		} catch (err) {
			errorHealth = err instanceof Error ? err.message : 'Failed to connect to daemon';
		} finally {
			loadingHealth = false;
		}
	}

	async function loadShadow() {
		if (isStaticMode()) {
			loadingShadow = false;
			return;
		}
		try {
			loadingShadow = true;
			errorShadow = '';
			shadowStatus = await fetchShadowStatus();
		} catch (err) {
			errorShadow = err instanceof Error ? err.message : 'Failed to load shadow status';
		} finally {
			loadingShadow = false;
		}
	}

	async function loadConventions() {
		if (isStaticMode()) {
			conventions = getSnapshot()?.conventions ?? [];
			loadingConventions = false;
			return;
		}
		try {
			loadingConventions = true;
			errorConventions = '';
			const response = await fetchConventions();
			conventions = response.items;
		} catch (err) {
			errorConventions = err instanceof Error ? err.message : 'Failed to load conventions';
		} finally {
			loadingConventions = false;
		}
	}

	function handleUpdate() {
		loadAllData();
	}

	// ── Helpers ──
	function formatUptime(seconds: number): string {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = Math.floor(seconds % 60);
		if (h > 0) return `${h}h ${m}m ${s}s`;
		if (m > 0) return `${m}m ${s}s`;
		return `${s}s`;
	}

	function toggleDomain(domain: string) {
		const next = new Set(expandedDomains);
		if (next.has(domain)) {
			next.delete(domain);
		} else {
			next.add(domain);
		}
		expandedDomains = next;
	}

	let loading = $derived(loadingConfig && loadingHealth && loadingShadow && loadingConventions);
</script>

<div class="flex flex-col gap-4 p-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold">Settings</h1>
			{#if !loading}
				<p class="text-sm text-muted-foreground" data-testid="settings-summary">
					Project configuration and daemon status
				</p>
			{/if}
		</div>
	</div>

	<div class="grid gap-4 md:grid-cols-2">
			<!-- ═══ Section 1: Project Configuration ═══ -->
			<Card data-testid="settings-project-config">
				<CardHeader class="pb-3">
					<div class="flex items-center gap-2">
						<FolderIcon class="size-4 text-muted-foreground" />
						<h2 class="text-sm font-semibold">Project Configuration</h2>
					</div>
				</CardHeader>
				<CardContent class="pt-0">
					{#if loadingConfig}
						<div class="flex flex-col gap-2" data-testid="settings-project-loading">
							<div class="h-4 w-3/4 rounded bg-muted ds-shimmer"></div>
							<div class="h-4 w-1/2 rounded bg-muted ds-shimmer"></div>
							<div class="h-4 w-2/3 rounded bg-muted ds-shimmer"></div>
						</div>
					{:else if errorConfig}
						<div class="text-sm text-destructive" data-testid="settings-project-error" role="alert">
							{errorConfig}
						</div>
					{:else if projectConfig}
						<dl class="flex flex-col gap-2 text-sm">
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Name</dt>
								<dd class="font-medium" data-testid="config-project-name">
									{projectConfig.project?.name ?? 'Not configured'}
								</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Version</dt>
								<dd class="font-mono text-xs" data-testid="config-project-version">
									{projectConfig.project?.version ?? '—'}
								</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Status</dt>
								<dd data-testid="config-project-status">
									<Badge variant="secondary" class="text-xs">
										{projectConfig.project?.status ?? '—'}
									</Badge>
								</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Spec Version</dt>
								<dd class="font-mono text-xs" data-testid="config-spec-version">
									{projectConfig.spec_version ?? '—'}
								</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Root Directory</dt>
								<dd class="font-mono text-xs truncate max-w-[200px]" title={projectConfig.root_dir} data-testid="config-root-dir">
									{projectConfig.root_dir}
								</dd>
							</div>
							<!-- AC: @ui-settings-view ac-1 — remote tracking -->
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Remote Tracking</dt>
								<dd data-testid="config-remote-tracking">
									{#if projectConfig.remote_tracking}
										<Badge variant="outline" class="text-xs">
											{projectConfig.remote_tracking.type}: {projectConfig.remote_tracking.value}
										</Badge>
									{:else}
										<span class="text-xs text-muted-foreground">None</span>
									{/if}
								</dd>
							</div>
						</dl>
					{:else}
						<div class="text-sm text-muted-foreground" data-testid="settings-project-empty">
							No project configuration found.
						</div>
					{/if}
				</CardContent>
			</Card>

			<!-- ═══ Section 2: Daemon Connection ═══ -->
			<Card data-testid="settings-daemon">
				<CardHeader class="pb-3">
					<div class="flex items-center gap-2">
						<ServerIcon class="size-4 text-muted-foreground" />
						<h2 class="text-sm font-semibold">Daemon Connection</h2>
					</div>
				</CardHeader>
				<CardContent class="pt-0">
					{#if loadingHealth}
						<div class="flex flex-col gap-2" data-testid="settings-daemon-loading">
							<div class="h-4 w-3/4 rounded bg-muted ds-shimmer"></div>
							<div class="h-4 w-1/2 rounded bg-muted ds-shimmer"></div>
						</div>
					{:else if errorHealth}
						<div class="flex flex-col gap-2">
							<div class="flex items-center gap-2">
								<span class="size-2 rounded-full bg-severity-error"></span>
								<span class="text-sm font-medium" data-testid="daemon-status">Disconnected</span>
							</div>
							<div class="text-sm text-destructive" data-testid="settings-daemon-error" role="alert">
								{errorHealth}
							</div>
						</div>
					{:else if health}
						<dl class="flex flex-col gap-2 text-sm">
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Status</dt>
								<dd class="flex items-center gap-2" data-testid="daemon-status">
									<span class="size-2 rounded-full bg-severity-success"></span>
									<span class="font-medium">Connected</span>
								</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Version</dt>
								<dd class="font-mono text-xs" data-testid="daemon-version">{health.version}</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Uptime</dt>
								<dd class="font-mono text-xs" data-testid="daemon-uptime">{formatUptime(health.uptime)}</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Active Connections</dt>
								<dd class="font-mono text-xs" data-testid="daemon-connections">{health.connections}</dd>
							</div>
							<!-- AC: @ui-settings-view ac-1 — daemon port -->
							{#if projectConfig}
								<div class="flex justify-between">
									<dt class="text-muted-foreground">Port</dt>
									<dd class="font-mono text-xs" data-testid="daemon-port">{projectConfig.daemon.port}</dd>
								</div>
							{/if}
						</dl>
					{:else if isStaticMode()}
						<div class="text-sm text-muted-foreground" data-testid="settings-daemon-static">
							Daemon connection details are unavailable in static mode.
						</div>
					{/if}
				</CardContent>
			</Card>

			<!-- ═══ Section 3: Shadow Branch ═══ -->
			<Card data-testid="settings-shadow">
				<CardHeader class="pb-3">
					<div class="flex items-center gap-2">
						<GitBranchIcon class="size-4 text-muted-foreground" />
						<h2 class="text-sm font-semibold">Shadow Branch</h2>
					</div>
				</CardHeader>
				<CardContent class="pt-0">
					{#if loadingShadow}
						<div class="flex flex-col gap-2" data-testid="settings-shadow-loading">
							<div class="h-4 w-3/4 rounded bg-muted ds-shimmer"></div>
							<div class="h-4 w-1/2 rounded bg-muted ds-shimmer"></div>
						</div>
					{:else if errorShadow}
						<div class="text-sm text-destructive" data-testid="settings-shadow-error" role="alert">
							{errorShadow}
						</div>
					{:else if shadowStatus}
						<dl class="flex flex-col gap-2 text-sm">
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Status</dt>
								<dd class="flex items-center gap-2" data-testid="shadow-status">
									{#if shadowStatus.enabled && shadowStatus.healthy}
										<span class="size-2 rounded-full bg-severity-success"></span>
										<span class="font-medium">Healthy</span>
									{:else if shadowStatus.enabled}
										<span class="size-2 rounded-full bg-severity-warning"></span>
										<span class="font-medium">Unhealthy</span>
									{:else}
										<span class="size-2 rounded-full bg-muted-foreground"></span>
										<span class="font-medium">Disabled</span>
									{/if}
								</dd>
							</div>
							{#if shadowStatus.branch_name}
								<div class="flex justify-between">
									<dt class="text-muted-foreground">Branch</dt>
									<dd class="font-mono text-xs" data-testid="shadow-branch">{shadowStatus.branch_name}</dd>
								</div>
							{/if}
							{#if shadowStatus.worktree_dir}
								<div class="flex justify-between">
									<dt class="text-muted-foreground">Worktree</dt>
									<dd class="font-mono text-xs truncate max-w-[200px]" title={shadowStatus.worktree_dir} data-testid="shadow-worktree">{shadowStatus.worktree_dir}</dd>
								</div>
							{/if}
							<div class="flex justify-between">
								<dt class="text-muted-foreground">Remote Tracking</dt>
								<dd data-testid="shadow-remote">
									{#if shadowStatus.remote_tracking}
										<Badge variant="outline" class="text-xs bg-severity-success-muted text-severity-success-muted-fg">Configured</Badge>
									{:else}
										<span class="text-xs text-muted-foreground">Not configured</span>
									{/if}
								</dd>
							</div>
						</dl>
					{:else if isStaticMode()}
						<div class="text-sm text-muted-foreground" data-testid="settings-shadow-static">
							Shadow branch status is unavailable in static mode.
						</div>
					{:else}
						<div class="text-sm text-muted-foreground" data-testid="settings-shadow-empty">
							Shadow branch not detected.
						</div>
					{/if}
				</CardContent>
			</Card>

			<!-- ═══ Section 4: Conventions ═══ -->
			<Card class="md:col-span-2" data-testid="settings-conventions">
				<CardHeader class="pb-3">
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2">
							<BookOpenIcon class="size-4 text-muted-foreground" />
							<h2 class="text-sm font-semibold">Conventions</h2>
						</div>
						{#if !loadingConventions && conventions.length > 0}
							<span class="text-xs text-muted-foreground" data-testid="conventions-count">
								{conventions.length} domain{conventions.length === 1 ? '' : 's'}
							</span>
						{/if}
					</div>
				</CardHeader>
				<CardContent class="pt-0">
					{#if loadingConventions}
						<div class="flex flex-col gap-2" data-testid="settings-conventions-loading">
							{#each Array(3) as _}
								<div class="h-10 rounded bg-muted ds-shimmer"></div>
							{/each}
						</div>
					{:else if errorConventions}
						<div class="text-sm text-destructive" data-testid="settings-conventions-error" role="alert">
							{errorConventions}
						</div>
					{:else if conventions.length === 0}
						<div class="flex flex-col items-center justify-center py-8" data-testid="settings-conventions-empty">
							<BookOpenIcon class="size-8 text-muted-foreground/30 mb-2" />
							<p class="text-sm text-muted-foreground">No conventions defined</p>
						</div>
					{:else}
						<div class="flex flex-col gap-1" data-testid="conventions-list">
							{#each conventions as convention (convention._ulid)}
								<div class="rounded-md border" data-testid="convention-item">
									<button
										type="button"
										class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors"
										onclick={() => toggleDomain(convention.domain)}
										data-testid="convention-toggle"
									>
										{#if expandedDomains.has(convention.domain)}
											<ChevronDownIcon class="size-3.5 text-muted-foreground shrink-0" />
										{:else}
											<ChevronRightIcon class="size-3.5 text-muted-foreground shrink-0" />
										{/if}
										<span class="font-medium" data-testid="convention-domain">{convention.domain}</span>
										<span class="text-xs text-muted-foreground ml-auto">
											{convention.rules.length} rule{convention.rules.length === 1 ? '' : 's'}
										</span>
									</button>
									{#if expandedDomains.has(convention.domain)}
										<div class="border-t px-3 py-2 text-sm" data-testid="convention-details">
											{#if convention.rules.length > 0}
												<ul class="flex flex-col gap-1 mb-2">
													{#each convention.rules as rule}
														<li class="text-muted-foreground flex items-start gap-1.5">
															<span class="text-xs mt-1 shrink-0">•</span>
															<span>{rule}</span>
														</li>
													{/each}
												</ul>
											{/if}
											{#if convention.examples && convention.examples.length > 0}
												<div class="flex flex-col gap-1.5 mt-2 pt-2 border-t">
													<h4 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Examples</h4>
													{#each convention.examples as example}
														<div class="flex flex-col gap-0.5 text-xs">
															<div class="flex items-center gap-1.5">
																<span class="text-severity-success font-medium">Good:</span>
																<code class="bg-muted px-1 py-0.5 rounded">{example.good}</code>
															</div>
															<div class="flex items-center gap-1.5">
																<span class="text-severity-error font-medium">Bad:</span>
																<code class="bg-muted px-1 py-0.5 rounded">{example.bad}</code>
															</div>
														</div>
													{/each}
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</CardContent>
			</Card>
	</div>
</div>
