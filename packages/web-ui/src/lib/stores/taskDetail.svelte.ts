// Store for task detail panel state
// Using traditional writable stores for SSR compatibility
import { writable, derived, get } from 'svelte/store';
import type { TaskDetail } from '@kynetic-ai/shared';

// Internal stores
const isOpen = writable(false);
const currentTask = writable<TaskDetail | null>(null);

// Exported store API
export const taskDetailStore = {
	// Subscribe methods for reactive access
	subscribe: isOpen.subscribe,

	// Derived values for components
	open: { subscribe: isOpen.subscribe },
	task: { subscribe: currentTask.subscribe },

	// Actions
	openWith(task: TaskDetail) {
		currentTask.set(task);
		isOpen.set(true);
	},
	close() {
		isOpen.set(false);
		currentTask.set(null);
	},

	// Get current values (for non-reactive access)
	getOpen() {
		return get(isOpen);
	},
	getTask() {
		return get(currentTask);
	}
};

// Export derived store for combined state
export const taskDetailState = derived(
	[isOpen, currentTask],
	([$isOpen, $currentTask]) => ({
		open: $isOpen,
		task: $currentTask
	})
);
