import { describe, expect, it, vi } from 'vitest'

import { findDiscountCode } from '@/pricing/findDiscountCode'

const fakePayload = (docs: unknown[] = []) => {
    const find = vi.fn(async (_args: unknown) => ({ docs }))
    return { find, payload: { find } as never }
}

describe('findDiscountCode', () => {
  it('queries by the normalised code', async ()=>{
    const { find, payload } = fakePayload([{ code: 'SUMMER10' }])
    const doc = await findDiscountCode(payload, '   summer10 ')

    expect(doc).toEqual({ code: 'SUMMER10' })
    expect(find).toHaveBeenCalledTimes(1)
    expect(find.mock.calls[0]?.[0]).toMatchObject({
        collection: 'discount-codes',
        limit: 1,
        overrideAccess: true,
        where: { code: { equals: 'SUMMER10' } },
    })  
  })

  it('returns null when nothing matches', async ()=>{
    const { payload } = fakePayload([])
    expect(await findDiscountCode(payload, 'NOPE')).toBeNull()
  })

  it('does not query for empty or non-string input', async ()=>{
    const { find, payload } = fakePayload([{ code: 'X'}])
    for ( const bad of ['', '   ', undefined, null, 5, {}]) {
        expect(await findDiscountCode(payload, bad)).toBeNull()
    }
    expect(find).not.toHaveBeenCalled()
  })

  it('returns null if the database hands back something that is not an object', async ()=>{
    const { payload } =fakePayload(['oops'])
    expect(await findDiscountCode(payload, 'SUMMER10')).toBeNull()
  })

  it('rethrows real failures instead of reporting "not found"',async ()=> {
    const find = vi.fn(async () => {
        throw new Error('Connection terminated unexpectedly')
    })
    await expect(findDiscountCode({ find } as never, 'SUMMER10')).rejects.toThrow('Connection terminated unexpectedly',)
  })
})
