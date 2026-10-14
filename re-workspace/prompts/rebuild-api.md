Analyze this HAR file. Reconstruct the API:
- Every endpoint with method, path, params, and request/response shape
- Auth mechanism (described, not values)
- Pagination, rate limit headers, error formats
Output an OpenAPI 3.1 spec to notes/openapi.yaml, then generate a typed
TypeScript client from it in notes/client.ts.
