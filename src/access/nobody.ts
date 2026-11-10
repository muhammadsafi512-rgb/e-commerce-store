import type { Access } from 'payload'

/**
 * Denies everyone, including admins, through the REST/GraphQL/admin UI.
 * Server code using the Local API (default `overrideAccess: true`) is unaffected.
 *
 * Used for `orders.delete`: orders are financial records and are never deleted.
 */

export const nobody: Access = () => false