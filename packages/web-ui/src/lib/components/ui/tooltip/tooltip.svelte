<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";

	const { open = $bindable(false), ...restProps }: TooltipPrimitive.RootProps = $props();
</script>

<TooltipPrimitive.Root bind:open {...restProps} />
