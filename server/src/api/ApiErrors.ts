import { Schema } from "effect"
import { HttpApiError, HttpApiMiddleware } from "effect/http-api"

export class RequestIssue extends Schema.Class<RequestIssue>("RequestIssue")({
  /** Location of the offending value, e.g. `["title"]` or `["items", 0, "name"]`. */
  path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
  message: Schema.String
}) {}

/** The request could not be decoded: bad params, headers, query or payload. */
export class RequestInvalid extends Schema.TaggedError<RequestInvalid>()(
  "RequestInvalid",
  {
    location: Schema.Literals(["Params", "Headers", "Query", "Payload"]),
    message: Schema.String,
    issues: Schema.Array(RequestIssue)
  },
  { httpApiStatus: 400 }
) {}

/**
 * Errors every endpoint can return, declared once for the whole API so the
 * typed client decodes them and they appear in OpenAPI and the Rust schema:
 *
 * - `RequestInvalid` (400): request decoding failed
 * - `InternalServerError` (500, empty body): an infrastructure failure. Handlers
 *   turn those into defects, which HttpApi renders as an empty 500; declaring it
 *   lets the typed client decode that into `InternalServerError`.
 *
 * Implemented in `http/ApiErrorsLive.ts`.
 */
export class ApiErrors extends HttpApiMiddleware.Service<ApiErrors>()("@q/server/api/ApiErrors", {
  error: [RequestInvalid, HttpApiError.InternalServerErrorNoContent]
}) {}
