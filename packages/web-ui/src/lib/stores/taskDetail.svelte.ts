// Store for task detail panel state — Svelte 5 runes
import type { TaskDetail } from '@kynetic-ai/shared';

let isOpen = $state(false);
let currentTask = $state<TaskDetail | null>(null);

export const taskDetailStore = {
	get open() {
		return isOpen;
	},
	get task() {
		return currentTask;
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
