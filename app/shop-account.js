const { StringDecoder } = require('string_decoder');

class ShopAccountError extends Error {
    constructor(message, status = 0) { super(message); this.status = status; }
}

class ShopAccountClient {
    constructor({ net, getSession, baseUrl, readToken = () => '', timeoutMs = 15000 }) {
        Object.assign(this, { net, getSession, baseUrl, readToken, timeoutMs });
    }

    request(apiPath, token = '') {
        const url = new URL(apiPath, this.baseUrl);
        if (url.origin !== new URL(this.baseUrl).origin || !/^\/api\/users\/electron\/(?:me|access)$/.test(url.pathname)) {
            return Promise.reject(new ShopAccountError('账号请求地址无效'));
        }
        return new Promise((resolve, reject) => {
            let request, timer, settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true; clearTimeout(timer);
                if (error) reject(error); else resolve(value);
            };
            try {
                // Electron 25 没有 Session.fetch；net.request 必须显式使用商店的 Cookie 分区。
                request = this.net.request({ url: url.href, method: 'GET', session: this.getSession(), useSessionCookies: true, redirect: 'error' });
                request.setHeader('Accept', 'application/json');
                request.setHeader('Cache-Control', 'no-cache');
                if (token) request.setHeader('Authorization', `Bearer ${token}`);
                timer = setTimeout(() => {
                    finish(new ShopAccountError('账号服务请求超时，请稍后重试'));
                    request.abort();
                }, this.timeoutMs);
                request.on('error', () => finish(new ShopAccountError('无法连接账号服务，请检查网络后重试')));
                request.on('abort', () => finish(new ShopAccountError('账号请求已取消')));
                request.on('response', response => {
                    const decoder = new StringDecoder('utf8');
                    let text = '', bytes = 0;
                    response.on('data', chunk => {
                        bytes += chunk.length;
                        if (bytes > 1024 * 1024) {
                            finish(new ShopAccountError('账号服务响应过大'));
                            request.abort(); return;
                        }
                        text += decoder.write(chunk);
                    });
                    response.on('error', () => finish(new ShopAccountError('账号服务响应中断，请重试')));
                    response.on('aborted', () => finish(new ShopAccountError('账号服务响应中断，请重试')));
                    response.on('end', () => {
                        const status = response.statusCode;
                        if (status < 200 || status >= 300) {
                            finish(new ShopAccountError(status === 401 ? '登录已失效，请重新登录' : '账号服务暂时不可用，请稍后重试', status));
                            return;
                        }
                        try { finish(null, JSON.parse(text + decoder.end())); }
                        catch (_) { finish(new ShopAccountError('账号服务返回了无效数据')); }
                    });
                });
                request.end();
            } catch (_) { finish(new ShopAccountError('无法发送账号请求，请稍后重试')); }
        });
    }

    async snapshot() {
        let token = '';
        let me;
        try {
            try { me = await this.request('/api/users/electron/me?typeCategory=tools'); }
            catch (error) {
                // 新统一账号使用 HttpOnly Cookie；只有明确未登录时才兼容旧 Bearer，避免旧令牌遮蔽有效会话。
                if (error.status !== 401) throw error;
                token = String(this.readToken() || '').trim();
                if (!token) throw error;
                me = await this.request('/api/users/electron/me?typeCategory=tools', token);
            }
            if (me?.authenticated === false || me?.data?.authenticated === false) throw new ShopAccountError('登录已失效，请重新登录', 401);
            const user = me?.user || me?.data?.user;
            if (!user || typeof user !== 'object' || !(user.id || user._id || user.username)) throw new ShopAccountError('账号服务返回了无效用户信息');
            const access = {};
            const categories = ['tools', 'python'];
            const results = await Promise.allSettled(categories.map(category => this.request(`/api/users/electron/access?typeCategory=${category}`, token)));
            categories.forEach((category, index) => {
                const result = results[index];
                if (result.status === 'rejected') { access[category] = { available: false, member: false }; return; }
                const payload = result.value?.data || result.value || {};
                const memberships = payload.entitlements?.activeMemberships || payload.activeMemberships || [];
                access[category] = {
                    available: true,
                    member: payload.canDownloadUpdates === true || payload.entitlements?.canDownloadUpdates === true ||
                        (Array.isArray(memberships) && memberships.some(item => [category, 'all'].includes(item?.planKey || item?.typeCategory || item?.category || item)))
                };
            });
            const publicUser = {};
            for (const key of ['id', '_id', 'nickname', 'name', 'username', 'email']) {
                if (typeof user[key] === 'string') publicUser[key] = user[key].slice(0, 512);
            }
            return { authenticated: true, user: publicUser, access, canDownloadUpdates: false, verificationFailed: false };
        } catch (error) {
            return { authenticated: false, user: null, access: {}, canDownloadUpdates: false,
                verificationFailed: error.status !== 401, error: error.message };
        }
    }
}

module.exports = { ShopAccountClient, ShopAccountError };
