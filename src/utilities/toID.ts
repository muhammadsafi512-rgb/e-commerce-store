export type DocID = number |string

/**
 * Returns the ID of a relationship value that may be a plain ID or a populated document.
 * Returns 'undefined' for anything that is not a usable ID.
 */

export const toID = (value: unknown): DocID | undefined => {
    const id = value && typeof value === 'object' ? (value as {id?: unknown }).id : value

    if ( typeof id === 'number' && Number.isFinite(id)) return id
    if ( typeof id === 'string' && id.length > 0) return id

    return undefined
}