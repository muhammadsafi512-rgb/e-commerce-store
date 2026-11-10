import { getPayload, type Payload } from "payload";
import config from "@/payload.config";
import { describe, it, expect, beforeAll } from "vitest";

import { nobody } from "@/access/nobody";

let payload: Payload;

//Minimal fake request users; access funtions only read 'req.user'.
const admin = { id: 1, roles: ['admin'] };
const customer = { id: 2, roles: ['customer'] };

describe('orders access control', () => {
    beforeAll(async () => {
        payload = await getPayload({ config: await config });
    });

    it('nobody() denies everyone', async () => {
        for (const user of [admin, customer, null]) {
            expect(await nobody({ req: { user } } as any)).toBe(false)
 }
})
it('orders.delete is wired to deny, even for admin', async () => {
    const del = payload.collections['orders'].config.access.delete
    expect(del).toBeDefined()
    expect(await del!({ req: { user: admin } } as any)).toBe(false)
    expect(await del!({ req: { user: customer } } as any)).toBe(false)
    expect(await del!({ req: { user: null } } as any)).toBe(false)
})

it('orders.update and orders.create stay admin-only (regression guard)', async () => {
    const { create, update } = payload.collections['orders'].config.access
    for (const fn of [create, update]) {
        expect( await fn!({ req: { user: admin } } as any)).toBe(true)
        expect( await fn!({ req: { user: customer } } as any)).toBe(false)
        expect( await fn!({ req: { user: null } } as any)).toBe(false)
    }
})
})