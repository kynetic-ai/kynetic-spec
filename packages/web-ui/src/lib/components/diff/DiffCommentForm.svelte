<!--
  AC: @review-code-diff-viewer ac-4 — Comment form opens inline between diff rows
-->
<script lang="ts">
	import type { ReviewThreadKind } from '@kynetic-ai/shared';

	interface Props {
		onSubmit: (body: string, kind: ReviewThreadKind) => void;
		onCancel: () => void;
	}

	let { onSubmit, onCancel }: Props = $props();

	let body = $state('');
	let kind = $state<ReviewThreadKind>('nit');

	function handleSubmit() {
		if (!body.trim()) return;
		onSubmit(body.trim(), kind);
	}
</script>

<div
	class="mx-8 my-1 border rounded-lg overflow-hidden bg-background shadow-sm"
	data-testid="diff-comment-form"
>
	<div class="p-3 flex flex-col gap-2">
		<div class="flex items-center gap-2">
			<label for="diff-comment-kind" class="text-xs font-medium">Kind:</label>
			<select
				id="diff-comment-kind"
				class="rounded-md border bg-background px-2 py-1 text-xs"
				bind:value={kind}
			>
					<option value="nit">Nit</option>
					<option value="question">Question</option>
					<option value="blocker">Blocker</option>
					<option value="idea">Idea</option>
				</select>
		</div>
		<label for="diff-comment-body" class="sr-only">Comment</label>
		<textarea
			id="diff-comment-body"
			class="w-full rounded-md border bg-background px-2 py-1.5 text-sm min-h-[60px] resize-y"
			data-testid="diff-comment-body"
			placeholder="Write your comment..."
			bind:value={body}
		></textarea>
		<div class="flex items-center gap-2">
			<button
				type="button"
				class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
				data-testid="diff-comment-submit"
				disabled={!body.trim()}
				onclick={handleSubmit}
			>
				Comment
			</button>
			<button
				type="button"
				class="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
				data-testid="diff-comment-cancel"
				onclick={onCancel}
			>
				Cancel
			</button>
		</div>
	</div>
</div>
