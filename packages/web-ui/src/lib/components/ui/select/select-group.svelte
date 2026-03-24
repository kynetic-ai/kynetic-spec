<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";

	const { ref = $bindable(null), ...restProps }: SelectPrimitive.GroupProps = $props();
</script>

<SelectPrimitive.Group bind:ref data-slot="select-group" {...restProps} />
