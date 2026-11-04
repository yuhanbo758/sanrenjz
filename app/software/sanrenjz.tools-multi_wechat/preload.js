const { contextBridge, ipcRenderer, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PLUGIN_NAME = '微信多开';

const DEFAULT_SETTINGS = {
  wechatExePath: '',
  instanceCount: 2,
  launchMethod: 'cmdStart',
  delayMs: 120,
  autoClose: false
};

function safeJsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function getSettingsInternal() {
  try {
    const stored = ipcRenderer.sendSync('plugin-storage-get', PLUGIN_NAME, 'settings');
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...safeJsonClone(stored) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettingsInternal(next) {
  const current = getSettingsInternal();
  const merged = { ...current, ...safeJsonClone(next || {}) };
  ipcRenderer.sendSync('plugin-storage-set', PLUGIN_NAME, 'settings', merged);
  return merged;
}

function normalizeExePath(exePath) {
  if (!exePath || typeof exePath !== 'string') return '';
  return exePath.trim().replace(/^"|"$/g, '');
}

function validateExePath(exePath) {
  const normalized = normalizeExePath(exePath);
  if (!normalized) return { ok: false, reason: '未设置微信程序路径' };
  if (!/\.exe$/i.test(normalized)) return { ok: false, reason: '请选择 .exe 文件' };
  try {
    const stat = fs.statSync(normalized);
    if (!stat.isFile()) return { ok: false, reason: '目标不是文件' };
  } catch {
    return { ok: false, reason: '微信程序路径不存在或无法访问' };
  }
  return { ok: true, exePath: normalized, dir: path.dirname(normalized) };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.min(max, Math.max(min, i));
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnDetached(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

function launchByCmdStart(exePath, cwd) {
  spawnDetached('cmd.exe', ['/c', 'start', '', '/d', cwd, exePath], { cwd });
}

function launchByDirect(exePath, cwd) {
  spawnDetached(exePath, [], { cwd });
}

async function launchWeChatInstances(payload) {
  const exePath = normalizeExePath(payload?.exePath);
  const count = clampInt(payload?.count, 1, 50, DEFAULT_SETTINGS.instanceCount);
  const delayMs = clampInt(payload?.delayMs, 0, 3000, DEFAULT_SETTINGS.delayMs);
  const method = payload?.method === 'direct' ? 'direct' : 'cmdStart';

  const v = validateExePath(exePath);
  if (!v.ok) {
    return { success: false, startedCount: 0, errors: [{ index: 0, message: v.reason }] };
  }

  const errors = [];
  let startedCount = 0;

  for (let i = 0; i < count; i += 1) {
    try {
      if (method === 'direct') {
        launchByDirect(v.exePath, v.dir);
      } else {
        launchByCmdStart(v.exePath, v.dir);
      }
      startedCount += 1;
    } catch (e) {
      errors.push({ index: i + 1, message: String(e?.message || e) });
    }
    if (delayMs > 0 && i < count - 1) {
      await sleep(delayMs);
    }
  }

  return { success: errors.length === 0, startedCount, errors };
}

function pickWeChatExe() {
  const result = ipcRenderer.sendSync('show-open-dialog', {
    title: '选择微信程序 (WeChat.exe / Weixin.exe)',
    properties: ['openFile'],
    filters: [{ name: '可执行文件', extensions: ['exe'] }]
  });
  // showOpenDialogSync returns string[] | undefined
  if (!result || !Array.isArray(result) || result.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, filePath: result[0] };
}

function openPathInExplorer(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return { success: false };
  shell.openPath(targetPath);
  return { success: true };
}

async function closeWindow() {
  return await ipcRenderer.invoke('close-plugin-window', PLUGIN_NAME);
}

const services = {
  getSettings: () => getSettingsInternal(),
  saveSettings: (next) => saveSettingsInternal(next),
  pickWeChatExe: () => pickWeChatExe(),
  validateExePath: (exePath) => validateExePath(exePath),
  launchWeChatInstances: async (payload) => await launchWeChatInstances(payload),
  openPath: (targetPath) => openPathInExplorer(targetPath),
  closeWindow: async () => await closeWindow()
};

try {
  contextBridge.exposeInMainWorld('services', services);
} catch {
  window.services = services;
}

window.exports = {
  'multi-wechat': {
    mode: 'none',
    args: {
      enter: () => {
        return;
      }
    }
  }
};

