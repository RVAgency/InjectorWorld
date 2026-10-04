import type {
  CollectionBeforeOperationHook,
  CollectionConfig,
  GlobalBeforeOperationHook,
  GlobalConfig,
  PayloadRequest,
} from 'payload'

/**
 * Row and depth caps for anonymous REST and GraphQL reads.
 *
 * Payload serves every collection at /api/<slug> (and through /api/graphql)
 * with caller-chosen `limit`, `depth` and `pagination`. The database pool is
 * capped at 4 connections (payload.config.ts), so a single anonymous
 * `?limit=100000` or `?depth=10` is a denial of service, not just a slow query.
 *
 * WHY THIS LIVES HERE AND NOT IN middleware.ts. The middleware used to "clamp"
 * these by rewriting the URL with smaller values. That never reached Payload:
 * Next 15 passes a middleware-rewritten query to pages as request metadata,
 * but an app route handler builds its Request from the ORIGINAL url, and
 * Payload parses its query from request.url. Confirmed 2026-10-05 on staging
 * AND production: anonymous `/api/zip-codes?limit=100000` returned all 41,488
 * rows. A beforeOperation hook runs inside Payload after the query is parsed,
 * so the cap holds whatever the transport (REST query, GraphQL body).
 *
 * Who is capped:
 *   - Callers with no verified user. `req.user` is resolved by Payload from
 *     the session, so a forged `payload-token` cookie does not skip the cap
 *     (the old middleware only checked that the cookie existed). The admin
 *     panel and signed-in dashboards are untouched.
 *   - REST and GraphQL only. Server code calls the Local API (payloadAPI
 *     'local'), and page builders, sitemaps and scripts rely on large reads
 *     there.
 *
 * In Payload, `limit: 0` and `pagination: false` both mean "every row", so
 * both count as over the cap. Neither was caught by the old middleware.
 */
export const MAX_ANON_LIMIT = 100
export const MAX_ANON_DEPTH = 2

type ReadArgs = {
  depth?: number
  limit?: number
  pagination?: boolean
  req?: PayloadRequest
}

function isAnonymousRemote(req: PayloadRequest | undefined): boolean {
  return Boolean(req && !req.user && req.payloadAPI !== 'local')
}

function capDepth<T extends ReadArgs>(args: T): T {
  if (typeof args.depth === 'number' && args.depth > MAX_ANON_DEPTH) {
    return { ...args, depth: MAX_ANON_DEPTH }
  }
  return args
}

function capRows<T extends ReadArgs>(args: T): T {
  let next = args
  if (next.pagination === false) {
    next = { ...next, pagination: true, limit: next.limit || MAX_ANON_LIMIT }
  }
  if (typeof next.limit === 'number' && (next.limit <= 0 || next.limit > MAX_ANON_LIMIT)) {
    next = { ...next, limit: MAX_ANON_LIMIT }
  }
  return next
}

/** find, findByID, findVersions, findVersionByID ('read') and findDistinct ('readDistinct'). */
const capAnonymousCollectionRead: CollectionBeforeOperationHook = ({ args, operation, req }) => {
  if (operation !== 'read' && operation !== 'readDistinct') return args
  if (!isAnonymousRemote(req)) return args
  return capDepth(capRows(args as ReadArgs)) as typeof args
}

/** Globals have no rows, only depth. */
const capAnonymousGlobalRead: GlobalBeforeOperationHook = ({ args, operation, req }) => {
  if (operation !== 'read' || !isAnonymousRemote(req)) return args
  return capDepth(args as ReadArgs)
}

/**
 * Appended LAST to each config's beforeOperation list, so no hook of the
 * collection's own can raise the numbers again after the cap is applied.
 */
export function withAnonymousReadCaps(collection: CollectionConfig): CollectionConfig {
  return {
    ...collection,
    hooks: {
      ...collection.hooks,
      beforeOperation: [...(collection.hooks?.beforeOperation ?? []), capAnonymousCollectionRead],
    },
  }
}

export function withAnonymousGlobalReadCaps(global: GlobalConfig): GlobalConfig {
  return {
    ...global,
    hooks: {
      ...global.hooks,
      beforeOperation: [...(global.hooks?.beforeOperation ?? []), capAnonymousGlobalRead],
    },
  }
}
