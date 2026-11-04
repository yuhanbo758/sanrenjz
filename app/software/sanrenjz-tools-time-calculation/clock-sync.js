const dgram = require('dgram');
const NTP_EPOCH = 2208988800;

function writeTimestamp(packet, offset, milliseconds) {
  const seconds = Math.floor(milliseconds / 1000) + NTP_EPOCH;
  packet.writeUInt32BE(seconds >>> 0, offset);
  packet.writeUInt32BE(Math.floor((milliseconds % 1000) / 1000 * 0x100000000) >>> 0, offset + 4);
}
function readTimestamp(packet, offset) {
  return (packet.readUInt32BE(offset) - NTP_EPOCH) * 1000 + packet.readUInt32BE(offset + 4) / 0x100000000 * 1000;
}
// SNTP 四时间戳估计：仅诊断本机时钟偏差，不修改系统时间。
function checkClock(host = 'pool.ntp.org', timeoutMs = 3500) {
  if (!/^[a-z0-9.-]{1,253}$/i.test(host)) return Promise.reject(new Error('服务器地址格式无效'));
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error('NTP 请求超时；请检查网络或 UDP 123 端口')), timeoutMs);
    socket.once('error', error => finish(new Error(`NTP 请求失败：${error.message}`)));
    const packet = Buffer.alloc(48); packet[0] = 0x23; // LI=0、版本 4、客户端模式 3
    const started = Date.now(); writeTimestamp(packet, 40, started);
    socket.once('message', response => {
      const received = Date.now();
      if (response.length < 48 || (response[0] & 7) !== 4 || (response[0] >> 6) === 3 || response[1] < 1 || response[1] > 15 || !response.subarray(24, 32).equals(packet.subarray(40, 48))) return finish(new Error('NTP 服务器响应无效'));
      const t2 = readTimestamp(response, 32), t3 = readTimestamp(response, 40);
      if (!t2 || !t3 || t3 < t2) return finish(new Error('NTP 时间戳无效'));
      const offsetMs = ((t2 - started) + (t3 - received)) / 2;
      const delayMs = (received - started) - (t3 - t2);
      finish(null, { host, offsetMs: Math.round(offsetMs), delayMs: Math.max(0, Math.round(delayMs)), checkedAt: new Date(received).toISOString() });
    });
    socket.send(packet, 123, host, error => { if (error) finish(new Error(`NTP 请求失败：${error.message}`)); });
  });
}
module.exports = { checkClock };
