import { t } from "elysia";

export function enumUnion(
  values: readonly string[],
) {
  return t.Union(values.map((value) => t.Literal(value)));
}

export function enumArrayUnion(
  values: readonly string[],
) {
  const literalUnion = enumUnion(values);
  return t.Union([literalUnion, t.Array(literalUnion)]);
}
