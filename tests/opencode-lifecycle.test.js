const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { OpenCodeRuntime } = require('../app/plugin_runtime/opencode-runtime');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-opencode-lifecycle-'));
  const children = [];
  const nativeOptions = {
    runtimeDirectory: path.join(fixture, 'private'), homeDirectory: fixture, env: { XDG_CONFIG_HOME: fixture },
    idleTimeoutMs: 25,
    spawn(_exe, _args, options) {
      assert.deepStrictEqual(options.stdio, ['ignore', 'ignore', 'ignore']);
      assert.notStrictEqual(options.cwd, os.homedir());
      assert.strictEqual(JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).snapshot, false);
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit('exit', 0); };
      children.push(child); return child;
    }
  };
  let session = 0, deletes = 0, aborts = 0, entered;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', data => chunks.push(data));
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/session' && request.method === 'POST') return response.end(JSON.stringify({ id: `s${++session}` }));
      if (request.url.endsWith('/message')) {
        entered?.();
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.parts[0].text.includes('hang')) return;
        return response.end(JSON.stringify({ parts: [{ type: 'text', text: 'ok' }] }));
      }
      if (request.url.endsWith('/abort')) { aborts++; return response.end('true'); }
      if (request.method === 'DELETE') { deletes++; return response.end('true'); }
      response.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const fetchReady = async () => new Response('{}');
    const idle = new OpenCodeRuntime({ ...nativeOptions, fetch: fetchReady });
    await idle.start();
    await wait(60);
    assert.strictEqual(idle.child, null);
    assert.strictEqual(children[0].killed, true);

    let probeEntered;
    const probing = new Promise(resolve => { probeEntered = resolve; });
    const blocked = new OpenCodeRuntime({ ...nativeOptions, startTimeoutMs: 60,
      fetch: (_url, options) => { probeEntered(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })); }
    });
    const start = blocked.start(); await probing;
    blocked.stop();
    await assert.rejects(start, /取消/);
    assert.strictEqual(blocked.child, null);
    assert.strictEqual(children[1].killed, true);

    const deadline = new OpenCodeRuntime({ ...nativeOptions, startTimeoutMs: 60,
      fetch: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
    });
    const startupBegan = Date.now();
    await assert.rejects(deadline.start(), /超时/);
    assert.ok(Date.now() - startupBegan < 500, '健康检查自身挂起时仍须遵守启动期限');
    assert.strictEqual(children[2].killed, true);
    assert.strictEqual(deadline.startController, null);

    const malformedConfig = new OpenCodeRuntime({ ...nativeOptions, env: { OPENCODE_CONFIG_CONTENT: '{broken' } });
    await assert.rejects(malformedConfig.start(), /配置/);
    assert.strictEqual(malformedConfig.startController, null);

    const runtime = new OpenCodeRuntime({ serverUrl: url, cleanupTimeoutMs: 80,
      spawn() { throw new Error('cleanup must never spawn another server'); } });
    const result = await runtime.complete({ requestId: 'done', messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(result.text, 'ok');
    assert.strictEqual(deletes, 1, 'complete 必须等到会话清理完毕再返回');
    const timed = Date.now();
    await assert.rejects(runtime.complete({ requestId: 'timeout', timeoutMs: 60, messages: [{ role: 'user', content: 'hang' }] }), /超时/);
    assert.ok(Date.now() - timed < 1000);
    assert.strictEqual(runtime.active.size, 0);
    assert.strictEqual(deletes, 2);
    assert.ok(aborts >= 1);

    const messageEntered = new Promise(resolve => { entered = resolve; });
    const pending = runtime.complete({ requestId: 'stop', messages: [{ role: 'user', content: 'hang' }] });
    await messageEntered; runtime.stop();
    await assert.rejects(pending, /取消/);
    assert.strictEqual(runtime.active.size, 0);
    assert.strictEqual(runtime.serverUrl, '');
    assert.strictEqual(deletes, 3);
    console.log('OpenCode lifecycle tests passed: idle shutdown, startup cancellation, bounded request deadline, awaited cleanup and no resurrection after stop');
  } finally {
    server.closeAllConnections(); server.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
