const path = require('path');
const { spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

function setupConsoleEncoding({ platform = process.platform, env = process.env, spawnSyncImpl = spawnSync } = {}) {
    if (platform !== 'win32') return { changed: false, reason: 'not-windows' };
    const powershell = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `$source = @'
using System.Runtime.InteropServices;
public static class SanrenjzConsoleEncoding {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCP(uint codePage);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleOutputCP(uint codePage);
    [DllImport("kernel32.dll")] public static extern uint GetConsoleCP();
    [DllImport("kernel32.dll")] public static extern uint GetConsoleOutputCP();
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
[SanrenjzConsoleEncoding]::FreeConsole() | Out-Null
if (-not [SanrenjzConsoleEncoding]::AttachConsole(${process.pid})) { exit 2 }
$inputSet = [SanrenjzConsoleEncoding]::SetConsoleCP(65001)
$outputSet = [SanrenjzConsoleEncoding]::SetConsoleOutputCP(65001)
$verified = $inputSet -and $outputSet -and [SanrenjzConsoleEncoding]::GetConsoleCP() -eq 65001 -and [SanrenjzConsoleEncoding]::GetConsoleOutputCP() -eq 65001
[SanrenjzConsoleEncoding]::FreeConsole() | Out-Null
if ($verified) { exit 0 } else { exit 3 }`;
    try {
        // 隐藏子进程可能拥有不同控制台，必须显式附加宿主后设置并回读，不能只看 chcp 退出码。
        const result = spawnSyncImpl(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
            windowsHide: true, stdio: 'ignore', timeout: 5000
        });
        return result.status === 0 && !result.error
            ? { changed: true, codePage: 65001 }
            : { changed: false, reason: 'console-unavailable' };
    } catch (_) {
        // 从桌面直接启动时可能没有控制台，不应阻止图形应用启动。
        return { changed: false, reason: 'console-unavailable' };
    }
}

function decodeUtf8Stream(stream, onText) {
    const decoder = new StringDecoder('utf8');
    let ended = false;
    const onData = chunk => {
        const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
        if (text) onText(text);
    };
    const onEnd = () => {
        if (ended) return;
        ended = true;
        const tail = decoder.end();
        if (tail) onText(tail);
    };
    // 仅用于已明确约定 UTF-8 的流，不能用它重新解释任意系统命令的 GBK 输出。
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    return () => {
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        stream.removeListener('close', onEnd);
    };
}

module.exports = { setupConsoleEncoding, decodeUtf8Stream };
