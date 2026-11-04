'use strict';
const assert = require('assert');
const net = require('net');
const { EventEmitter } = require('events');
const { app } = require('electron');
const selfsigned = require('selfsigned');
const { RemoteService } = require('../app/remote/service');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  return server.address().port;
}
async function run() {
  await app.whenReady();
  const reserved = net.createServer();
  const port = await listen(reserved);
  await new Promise(resolve => reserved.close(resolve));
  let settings = { remoteControl: { enabled: true, port } };
  const service = new RemoteService({ app, ipcMain: new EventEmitter(), manager: {}, loadSettings: () => settings, saveSettings: value => { settings = value; } });
  const tls = selfsigned.generate([{ name: 'commonName', value: 'test-local' }], { keySize: 2048, algorithm: 'sha256' });
  service.loadIdentity = async () => { await pause(40); service.identity = { pcId: 'test', tls: { key: tls.private, cert: tls.cert }, devices: [] }; };
  let frames=0;
  service.client={device:{id:'phone'}};
  service.mirror={session:null,receive:()=>frames++,stop:()=>{}};
  await service.incoming({type:'mirror-frame',value:{id:'expired'}});assert.strictEqual(frames,0);
  service.mirror.session={id:'live'};
  await service.incoming({type:'mirror-frame',value:{id:'expired'}});assert.strictEqual(frames,0);
  await service.incoming({type:'mirror-frame',value:{id:'live'}});assert.strictEqual(frames,1);
  service.client=null;
  try {
    await Promise.all([service.start(), service.start(), service.configure({ enabled: true, port }), service.start()]);
    assert.strictEqual(service.status().running, true);
    await Promise.all([service.stop(), service.stop()]);
    assert.strictEqual(service.status().running, false);
    const blocker = net.createServer(); await listen(blocker, port);
    try {
      await assert.rejects(service.start(), error => error.code === 'EADDRINUSE' && error.message.includes('已被其他服务占用'));
      assert.strictEqual(service.server, null); assert.strictEqual(service.wss, null);
      assert.strictEqual(service.status().running, false);
    } finally { await new Promise(resolve => blocker.close(resolve)); }
    await service.start();
    assert.strictEqual(service.status().running, true);
    console.log('REMOTE_LIFECYCLE_PASS: 并发启用、配置与停止、端口占用提示、失败后重启通过');
  } finally { await service.stop(); }
}
run().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
