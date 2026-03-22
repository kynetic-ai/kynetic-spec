export function describeEnumValues(
  label: string,
  values: readonly string[],
  joiner = ", ",
): string {
  return `${label} (${values.join(joiner)})`;
}

