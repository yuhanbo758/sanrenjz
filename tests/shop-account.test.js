const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ShopAccountClient } = require('../app/shop-account');

function fixture(handler, timeoutMs = 100) {
    const calls = [];
    const fakeSession = {};
    const net = { request(options) {
        const request = new EventEmitter();
        const call = { ...options, headers: {} }; calls.push(call);
        request.setHeader = (key, value) => { call.headers[key] = value; };
        request.abort = () => { call.aborted = true; request.emit('abort'); };
        request.end = () => queueMicrotask(() => {
            const result = handler(call);
            if (result?.hang) return;
            if (result?.error) { request.emit('error', new Error('not exposed')); return; }
            const response = new EventEmitter(); response.statusCode = result.status || 200;
            request.emit('response', response);
            const body = Buffer.from(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
            const split = body.indexOf(Buffer.from('测试')) + 1;
            if (split > 0) { response.emit('data', body.subarray(0, split)); response.emit('data', body.subarray(split)); }
            else response.emit('data', body);
            response.emit('end');
        });
        return request;
    } };
    let reads = 0;
    const client = new ShopAccountClient({ net, getSession: () => fakeSession, baseUrl: 'https://shop.example.test', readToken: () => { reads++; return 'legacy-fixture'; }, timeoutMs });
    return { client, calls, fakeSession, reads: () => reads };
}

const profile = { user: { id: 'fixture-user', username: '测试用户', password: null } };
test('商店 Cookie 认证优先，使用同一 Session 且不读取旧令牌', async () => {
    const f = fixture(call => ({ body: call.url.includes('/me?') ? profile : { canDownloadUpdates: call.url.includes('typeCategory=tools') } }));
    const result = await f.client.snapshot();
    assert.equal(result.authenticated, true); assert.equal(result.user.username, '测试用户');
    assert.equal(result.user.password, undefined); assert.equal(result.access.tools.member, true); assert.equal(result.access.python.member, false);
    assert.equal(result.canDownloadUpdates, false); assert.equal(f.reads(), 0); assert.equal(f.calls.length, 3);
    for (const call of f.calls) { assert.equal(call.session, f.fakeSession); assert.equal(call.useSessionCookies, true); assert.equal(call.redirect, 'error'); assert.equal(call.headers.Authorization, undefined); }
});
test('仅 Cookie 明确401时兼容已有Bearer，不在网络错误或503时降级', async () => {
    const f = fixture(call => !call.headers.Authorization ? { status: 401, body: {} } : { body: call.url.includes('/me?') ? profile : { activeMemberships: ['python'] } });
    const result = await f.client.snapshot();
    assert.equal(result.authenticated, true); assert.equal(result.access.tools.member, false); assert.equal(result.access.python.member, true);
    assert.equal(f.reads(), 1); assert.equal(f.calls.length, 4);
    for (const cause of [{ status: 503, body: {} }, { error: true }]) {
        const failed = fixture(() => cause); const snapshot = await failed.client.snapshot();
        assert.equal(snapshot.authenticated, false); assert.equal(snapshot.verificationFailed, true); assert.equal(failed.reads(), 0); assert.equal(failed.calls.length, 1);
    }
});
test('两类权限查询互相隔离，失败不抹掉已确认账号', async () => {
    const f = fixture(call => call.url.includes('/me?') ? { body: profile } : call.url.includes('tools') ? { status: 503, body: {} } : { body: { entitlements: { activeMemberships: [{ planKey: 'python' }] } } });
    const result = await f.client.snapshot();
    assert.equal(result.authenticated, true); assert.deepEqual(result.access.tools, { available: false, member: false }); assert.equal(result.access.python.member, true);
});
test('HTTP200空响应或HTML不能误判为登录成功', async () => {
    for (const body of [{}, '<html>login</html>']) {
        const f = fixture(() => ({ body })); const result = await f.client.snapshot();
        assert.equal(result.authenticated, false); assert.equal(result.verificationFailed, true);
    }
});
test('HTTP200明确未登录立即清除认证状态，不尝试旧Bearer', async () => {
    for (const body of [{ authenticated: false }, { authenticated: false, user: profile.user }, { data: { authenticated: false } }]) {
        const f = fixture(() => ({ body })); const result = await f.client.snapshot();
        assert.equal(result.authenticated, false); assert.equal(result.verificationFailed, false);
        assert.equal(f.reads(), 0); assert.equal(f.calls.length, 1);
    }
});
test('请求超时终止且拒绝外站和非账号接口，不回传服务端原始错误', async () => {
    const f = fixture(() => ({ hang: true }), 10);
    await assert.rejects(f.client.request('/api/users/electron/me'), /超时/); assert.equal(f.calls[0].aborted, true);
    await assert.rejects(f.client.request('https://other.example.test/api/users/electron/me'), /地址无效/);
    await assert.rejects(f.client.request('/api/account/orders'), /地址无效/); assert.equal(f.calls.length, 1);
    const error = fixture(() => ({ status: 401, body: { error: 'sensitive server body' } }));
    const result = await error.client.snapshot(); assert.equal(result.verificationFailed, false); assert(!JSON.stringify(result).includes('sensitive server body'));
});
