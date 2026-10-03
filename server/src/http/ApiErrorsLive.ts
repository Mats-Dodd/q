import { Effect, Match, SchemaIssue } from "effect"
import type { HttpApiError } from "effect/http-api"
import { HttpApiMiddleware } from "effect/http-api"
import { ApiErrors, RequestInvalid, RequestIssue } from "../api/ApiErrors.ts"

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const toPathSegment = (segment: PropertyKey | { readonly key: PropertyKey }): string | number => {
  const key = typeof segment === "object" ? segment.key : segment
  return typeof key === "number" ? key : String(key)
}

const toRequestInvalid = (
  location: RequestInvalid["location"],
  error: HttpApiError.HttpApiSchemaError
) =>
  RequestInvalid.make({
    location,
    message: error.cause.message,
    issues: formatIssues(error.cause.issue).issues.map((issue) =>
      RequestIssue.make({
        path: (issue.path ?? []).map(toPathSegment),
        message: issue.message
      })
    )
  })

/**
 * Turns request decoding failures (which HttpApi otherwise renders as an empty
 * 400) into a `RequestInvalid` body. Response encoding failures are server bugs
 * and are left alone.
 */
export const ApiErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(
  ApiErrors,
  (error) =>
    Match.value(error.kind).pipe(
      Match.when(
        Match.is("Params", "Headers", "Query", "Payload"),
        (location) => Effect.fail(toRequestInvalid(location, error))
      ),
      Match.when(Match.is("Body", "ResponseHeaders"), () => Effect.fail(error)),
      Match.exhaustive
    )
)
