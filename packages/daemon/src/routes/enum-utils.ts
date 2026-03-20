import { t } from "elysia";

export function enumUnion<const T extends readonly [string, ...string[]]>(
  values: T,
) {
  return t.Union(values.map((value) => t.Literal(value)));
}

