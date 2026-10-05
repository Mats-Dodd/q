import { JsonSchema, Schema } from "effect"
import { OpenApi } from "effect/http-api"
import type { SchemaRepresentation } from "effect"
import { Api } from "../api/Api.ts"
import { StreamControl } from "../api/SessionStreamApi.ts"

/**
 * Wire types the API only carries as JSON text (inside SSE event data), so
 * OpenAPI sees a string. Listed here so generated clients get their shape;
 * each needs an `identifier`.
 */
const embedded = [StreamControl]

/**
 * External consumers want plain names: drop the `Encoded` suffix Effect adds to
 * class identifiers on the encoded side, and the `effect/HttpApiError/`
 * namespace on built-in HTTP errors.
 */
const referencePolicy: SchemaRepresentation.ReferencePolicy = ({ identifier }) =>
  identifier?.replace(/^effect\/HttpApiError\//, "").replace(/Encoded$/, "")

/** OpenAPI 3.1 document for the HTTP API. */
export const openApi = () => OpenApi.fromApi(Api, { referencePolicy })

/**
 * Draft-07 JSON Schema for every named type in the API, shaped for Rust codegen
 * (`typify`). Derived from the OpenAPI components, so the `Api` is the single
 * source of truth: anything with an `identifier` that the API uses is included
 * automatically (plus the `embedded` types above).
 */
export const wireJsonSchema = () => {
  const components = openApi().components.schemas
  const definitions = Object.fromEntries(
    Object.entries(components).map(([name, schema]) => [name, JsonSchema.fromSchemaOpenApi3_1(schema).schema])
  )
  for (const schema of embedded) {
    Object.assign(definitions, Schema.toJsonSchemaDocument(schema, { referencePolicy, onExcessProperty: "error" }).definitions)
  }
  const draft07 = JsonSchema.toDocumentDraft07({ dialect: "draft-2020-12", schema: {}, definitions })
  return { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07, definitions: draft07.definitions }
}

/** Generated artifacts checked into `generated/`, keyed by path. */
export const artifacts = (): Record<string, unknown> => ({
  "generated/wire.schema.json": wireJsonSchema(),
  "generated/openapi.json": openApi()
})

export const render = (document: unknown) => JSON.stringify(document, null, 2) + "\n"
