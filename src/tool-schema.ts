import type {InferValue, ParameterSchemaSpec, ValueSchemaSpec} from '@deepseek-ai/dsh-tools';
import {z} from 'zod';

type SchemaNode = {type?: string; properties?: Record<string, SchemaNode>; required?: string[];
  additionalProperties?: boolean; items?: SchemaNode; anyOf?: SchemaNode[]; oneOf?: SchemaNode[];
  enum?: unknown[]; const?: unknown; description?: string};

/** Project the shared contract into DSH's supported DSL; Zod enforces its size/refinement rules at execution. */
export function valueSpec(node: SchemaNode): ValueSchemaSpec {
  const union = node.anyOf ?? node.oneOf;
  if (union) {
    if (union.length < 2) throw new Error('Tool schema union must contain at least two alternatives');
    return {oneOf: union.map(valueSpec) as [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]};
  }
  if (node.type === 'object') return {type: 'object', additionalProperties: false, properties: parameterSpec(node)};
  if (node.type === 'array') return {type: 'array', items: node.items ? valueSpec(node.items) : undefined};
  if (!['string', 'integer', 'number', 'boolean', 'null'].includes(node.type ?? '')) {
    throw new Error(`Unsupported tool schema type: ${node.type}`);
  }
  return {type: node.type, ...(node.enum ? {enum: node.enum} : {}),
    ...('const' in node ? {const: node.const} : {})} as ValueSchemaSpec;
}

export function parameterSpec(node: SchemaNode): ParameterSchemaSpec {
  return Object.fromEntries(Object.entries(node.properties ?? {}).map(([name, child]) => [name, {
    ...valueSpec(child), ...(node.required?.includes(name) ? {required: true as const} : {}),
    ...(child.description ? {description: child.description} : {}),
  }]));
}

export function parameters(schema: z.ZodType): ParameterSchemaSpec {
  return parameterSpec(z.toJSONSchema(schema, {io: 'input'}) as SchemaNode);
}

// Strip optional undefined members before DSH checks the lossless JSON boundary.
export const OUTPUT_SCHEMA = {type: 'object', additionalProperties: true} as const;
export function jsonObject(value: object): InferValue<typeof OUTPUT_SCHEMA> {return JSON.parse(JSON.stringify(value)) as InferValue<typeof OUTPUT_SCHEMA>;}
export function renderValue(_args: unknown, value: unknown) {return [{type: 'text' as const, text: JSON.stringify(value)}];}
