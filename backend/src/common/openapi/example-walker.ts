/**
 * Checks that an OpenAPI schema carries examples (DBS-137, DoD 1: "ví dụ request/response").
 *
 * An example at any level above a leaf is enough (a media type `example`, a schema `example`),
 * because the author then showed the whole value. Without one the walk resolves `$ref`,
 * `allOf`/`oneOf`/`anyOf`, array `items` and every property, and each leaf needs an `example`,
 * `enum`, `const` or `default`. Pure: no I/O, used by the OpenAPI completeness test.
 */

export type SchemaObject = {
  $ref?: string;
  type?: string;
  example?: unknown;
  examples?: unknown;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  additionalProperties?: boolean | SchemaObject;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  nullable?: boolean;
  format?: string;
};
export type SchemaMap = Record<string, SchemaObject>;
export type MediaObject = { schema?: SchemaObject; example?: unknown; examples?: unknown };

/** Shared error schemas: one DTO serves several statuses, so their examples live on the media type. */
export const PROBLEM_SCHEMA = /(^|[a-z])ProblemDto$|^ProblemDetailsDto$/;

const REF = '#/components/schemas/';

const hasExample = (schema: SchemaObject): boolean =>
  schema.example !== undefined ||
  (schema.examples !== undefined &&
    schema.examples !== null &&
    Object.keys(schema.examples).length > 0);

const isLeafCovered = (schema: SchemaObject): boolean =>
  schema.example !== undefined ||
  (schema.enum !== undefined && schema.enum.length > 0) ||
  schema.const !== undefined ||
  schema.default !== undefined;

/** Paths of the leaves that lack an example; `[]` when the schema is fully exemplified. */
export function findExampleGaps(
  schema: SchemaObject,
  components: SchemaMap,
  path = '',
  seen: ReadonlySet<string> = new Set(),
): string[] {
  const join = (key: string): string => (path === '' ? key : `${path}.${key}`);
  if (hasExample(schema)) return [];
  if (schema.$ref !== undefined) {
    const name = schema.$ref.startsWith(REF) ? schema.$ref.slice(REF.length) : schema.$ref;
    if (PROBLEM_SCHEMA.test(name) || seen.has(name)) return [];
    const target = components[name];
    if (target === undefined) return [`${path || '(root)'} -> missing schema ${name}`];
    return findExampleGaps(target, components, path, new Set([...seen, name]));
  }
  const members = schema.allOf ?? schema.oneOf ?? schema.anyOf;
  if (members !== undefined) {
    return members.flatMap(member => findExampleGaps(member, components, path, seen));
  }
  if (schema.type === 'array') {
    return schema.items === undefined
      ? [`${path || '(root)'}[]`]
      : findExampleGaps(schema.items, components, `${path}[]`, seen);
  }
  if (schema.properties !== undefined) {
    return Object.entries(schema.properties).flatMap(([key, child]) =>
      findExampleGaps(child, components, join(key), seen),
    );
  }
  if (isLeafCovered(schema)) return [];
  // A free-form object (additionalProperties only), an object with no properties, or a plain leaf.
  return [path || '(root)'];
}

/** Gaps of a media type: its own example is enough, otherwise the schema is walked. */
export function mediaExampleGaps(media: MediaObject | undefined, components: SchemaMap): string[] {
  if (media === undefined) return ['(no content)'];
  if (hasExample(media)) return [];
  if (media.schema === undefined) return ['(no schema)'];
  return findExampleGaps(media.schema, components);
}
