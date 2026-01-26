// Store for task detail panel state - works around bits-ui Portal reactivity issues in Svelte 5
import type { TaskDetail } from '@kynetic-ai/shared';

// Using Svelte 5 runes for reactive state
let isOpen = $state(false);
let currentTask = $state<TaskDetail | null>(null);

export const taskDetailStore = {
	get open() {
		return isOpen;
	},
	set open(value: boolean) {
		isOpen = value;
	},
	get task() {
		return currentTask;
	},
	set task(value: TaskDetail | null) {
		currentTask = value;
	},
	openWith(task: TaskDetail) {
		currentTask = task;
		isOpen = true;
	},
	close() {
		isOpen = false;
		currentTask = null;
	}
};
