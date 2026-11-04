'use strict';
const crypto = require('crypto');
const VERSION = 1;
const METHODS = new Set(['catalog', 'chat-tools', 'chat-models', 'chat', 'chat-status', 'chat-history', 'chat-cancel', 'chat-confirm', 'file-select', 'upload-start', 'upload-chunk', 'upload-end', 'download', 'files', 'account', 'settings', 'cast-status', 'cast-control', 'cast-enqueue','cast-open','mirror-start','mirror-stop','mirror-status']);
function equal(a, b) {
  const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function parse(value) {
  const message = typeof value === 'string' ? JSON.parse(value) : value;
  if (!message || message.v !== VERSION || typeof message.id !== 'string' || message.id.length > 96 || !METHODS.has(message.method)) throw new Error('无效的远程请求');
  return { id: message.id, method: message.method, params: message.params || {} };
}
function localAddress(value) {
  const address=String(value||'').replace(/^::ffff:/,'');
  const parts=address.split('.').map(Number);
  if(parts.length!==4||parts.some(part=>!Number.isInteger(part)||part<0||part>255))return false;
  return parts[0]===127||parts[0]===10||(parts[0]===192&&parts[1]===168)||(parts[0]===172&&parts[1]>=16&&parts[1]<=31);
}
module.exports = { VERSION, METHODS, equal, parse, localAddress };
