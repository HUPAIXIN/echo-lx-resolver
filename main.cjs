'use strict';

/*
 * LX 音源解析 (echo.lx-resolver) — main-process side.
 *
 * 完成三件事:
 *  1. 包装主进程全局 `__shinawaseResolveStreamingPlayback`(ECHO 播放链路与
 *     ECHO Streaming 下载都经过它),按用户选择的解析源分流:
 *       - account → 原生行为(有账号 cookie 时用账号解析)
 *       - local   → 网易走无 cookie 的公共解析(强制"未登录"行为),其余平台走原生
 *       - lx:<id> → 在 vm 沙箱里运行洛雪音源脚本,取回播放 URL
 *  2. 接管 IPC `streaming:resolvePlayback`(渲染进程显式解析,如下载/音质探测),
 *     同样经过包装后的 resolver。
 *  3. 音源管理:添加(URL / JS / JSON / TXT)、更新、编辑、删除,存储于
 *     userData/shinawase-lx-resolver/。
 */

const { createHash, randomUUID } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ECHO_UA = 'Mozilla/5.0 ECHO/1.0';
const MUSIC_UA = DEFAULT_UA;

const PROVIDER_TO_LX = { netease: 'wy', qqmusic: 'tx' };
const QUALITY_TO_LX = { standard: '128k', high: '320k', lossless: 'flac', hires: 'hires' };
const LX_QUALITY_RANK = { '128k': 0, '320k': 1, flac: 2, flac24bit: 3, hires: 4, atmos: 5, master: 6 };

module.exports = async function activate(host) {
  const electron = host.electron;
  const ipcMain = host.ipcMain || electron?.ipcMain;
  const app = host.app || electron?.app;
  const log = (level, message) => { try { host.log(level, `[lx-resolver] ${message}`); } catch { /* noop */ } };

  const dataDir = joinUserDir(app, 'shinawase-lx-resolver');
  const scriptsDir = path.join(dataDir, 'scripts');
  try { mkdirSync(scriptsDir, { recursive: true }); } catch { /* noop */ }
  const sourcesFile = path.join(dataDir, 'sources.json');
  const stateFile = path.join(dataDir, 'state.json');

  // ---------------------------------------------------------------- storage

  const readJson = (file, fallback) => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
  };
  const writeJson = (file, value) => {
    try { mkdirSync(path.dirname(file), { recursive: true }); } catch { /* noop */ }
    try {
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    } catch (error) { log('WARN', `persist failed: ${error.message}`); }
  };

  let sources = readJson(sourcesFile, []);
  if (!Array.isArray(sources)) sources = [];
  const state = readJson(stateFile, { mode: 'local' });
  if (typeof state.mode !== 'string' || !state.mode) state.mode = 'local';

  const persistSources = () => writeJson(sourcesFile, sources);
  const persistState = () => writeJson(stateFile, state);

  const notifyRenderer = (name, payload) => {
    try { host.broadcast('lx-resolver', { event: name, payload }); } catch { /* noop */ }
  };

  // ------------------------------------------------------------ lx runtime

  const EVENT_NAMES = {
    request: 'request',
    inited: 'inited',
    updateAlert: 'updateAlert',
    currentMusicItem: 'currentMusicItem',
    playerPrev: 'playerPrev',
    playerNext: 'playerNext',
    playerTogglePlay: 'playerTogglePlay',
    playerPlaying: 'playerPlaying',
    playerPause: 'playerPause',
    playerResume: 'playerResume',
    playerStop: 'playerStop',
  };

  // lx.request 回调式 HTTP,按洛雪约定返回 { statusCode, body, headers }。
  const lxHttpRequest = (url, options = {}, callback) => {
    const method = String(options.method || 'GET').toUpperCase();
    const timeoutMs = Math.min(Math.max(Number(options.timeout) || 15000, 1000), 60000);
    let redirects = Number.isFinite(options.follow_max) ? options.follow_max : 5;
    let body = options.body;
    const headers = { ...(options.headers || {}) };
    if (body && typeof body === 'object' && !(body instanceof Buffer) && !(body instanceof Uint8Array)) {
      body = JSON.stringify(body);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
    const finish = (error, response) => setImmediate(() => callback(error, response));

    const attempt = (target) => {
      let scheme;
      try { scheme = new URL(target); } catch { return finish(new Error(`invalid url: ${target}`)); }
      const client = scheme.protocol === 'https:' ? https : http;
      const request = client.request(target, {
        method,
        headers: { 'User-Agent': MUSIC_UA, ...headers },
        timeout: timeoutMs,
      });
      let settled = false;
      const done = (error, response) => {
        if (settled) return;
        settled = true;
        if (error) { try { request.destroy(); } catch { /* noop */ } finish(error, null); }
        else finish(null, response);
      };
      request.on('timeout', () => done(new Error('request timed out')));
      request.on('error', (error) => done(error));
      request.on('response', (response) => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          if (redirects-- > 0) return attempt(new URL(response.headers.location, target).toString());
          return done(new Error('too many redirects'));
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size <= 32 * 1024 * 1024) chunks.push(chunk);
          else response.destroy();
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text;
          const trimmed = text.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { parsed = JSON.parse(trimmed); } catch { parsed = text; }
          }
          done(null, { statusCode: status, headers: response.headers, body: parsed });
        });
        response.on('error', (error) => done(error));
      });
      if (body != null && method !== 'GET' && method !== 'HEAD') request.write(body);
      request.end();
    };
    attempt(url);
  };

  const runningSources = new Map(); // id -> { sandbox, onRequest, inited, platforms }
  const updateAlertWaiters = new Map(); // id -> resolve({log, updateUrl}) —— 主动检测更新时挂起
  // 更新自检节流:每天(UTC)首次启动放行音源脚本的自检,同一天内再启动则跳过。
  const updateChecksFile = path.join(dataDir, 'update-checks.json');
  const todayUtc = () => new Date().toISOString().slice(0, 10);
  let updateCheckToday = readJson(updateChecksFile, {}).lastCheckDate || null;
  const markUpdateChecked = () => {
    updateCheckToday = todayUtc();
    writeJson(updateChecksFile, { lastCheckDate: updateCheckToday });
  };
  // 本次激活内所有音源的自检都放行一次;日期标记只拦截后续的启动。
  let updateCheckAllowedThisBoot = updateCheckToday !== todayUtc();
  let bootCheckMarked = false;
  const allowUpdateCheck = () => {
    if (updateCheckAllowedThisBoot && !bootCheckMarked) {
      bootCheckMarked = true;
      markUpdateChecked();
    }
    return updateCheckAllowedThisBoot;
  };
  const updateCheckAllowed = allowUpdateCheck;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeVersion = (value) => String(value || '').replace(/^v/iu, '').trim();

  const makeCompat = (entry, sourceId) => {
    const listeners = new Map();
    const compat = {
      EVENT_NAMES,
      env: 'echo',
      version: '2.0.0',
      currentScriptInfo: { name: entry.name, version: entry.version, author: entry.author, description: entry.description },
      request(url, options, callback) {
        if (typeof options === 'function') { callback = options; options = {}; }
        const isUpdateCheck = /checkUpdate=/iu.test(String(url));
        if (isUpdateCheck && !allowUpdateCheck()) {
          // 今天已经检测过:静默跳过,红点沿用已有状态。
          setImmediate(() => callback(new Error('update check skipped (already checked today)'), null));
          return;
        }
        try {
          lxHttpRequest(url, options || {}, (error, response) => {
            if (isUpdateCheck) {
              const status = Number(response?.statusCode ?? response?.status ?? 0);
              if (error || (status && status >= 400)) entry.updateCheckFailed = true;
              else entry.updateCheckFailed = false;
              if (!error && (!status || status < 400)) {
                // 今天首次放行的自检:记录日期并重置红点,音源若上报更新会再次点亮。
                if (allowUpdateCheck()) {
                  markUpdateChecked();
                  const record = sources.find((item) => item.id === sourceId);
                  if (record && record.hasUpdate) {
                    record.hasUpdate = false;
                    persistSources();
                    notifyRenderer('sources-changed', {});
                  }
                }
              }
            }
            callback(error, response);
          });
        } catch (error) {
          if (isUpdateCheck) entry.updateCheckFailed = true;
          setImmediate(() => callback(error, null));
        }
      },
      on(name, handler) {
        listeners.set(String(name), handler);
      },
      send(name, data) {
        if (name === EVENT_NAMES.inited) {
          entry.inited = data || {};
          entry.platforms = {};
          const declared = data?.sources;
          if (declared && typeof declared === 'object') {
            for (const [key, value] of Object.entries(declared)) {
              entry.platforms[String(key)] = {
                name: String(value?.name || key),
                actions: Array.isArray(value?.actions) ? value.actions.map(String) : [],
                qualitys: Array.isArray(value?.qualitys) ? value.qualitys.map(String) : [],
              };
            }
          }
          log('INFO', `source "${entry.name}" inited: ${Object.keys(entry.platforms).join(', ') || 'no platforms'}`);
        } else if (name === EVENT_NAMES.updateAlert) {
          // 洛雪音源自报更新:有 updateAlert 即代表作者服务器认定"有新版本"。
          const updateUrl = String(data?.updateUrl || '').trim();
          entry.updateUrl = updateUrl || entry.updateUrl;
          const record = sources.find((item) => item.id === sourceId);
          if (record) {
            if (updateUrl && record.updateUrl !== updateUrl) {
              record.updateUrl = updateUrl;
            }
            record.hasUpdate = true;
            persistSources();
            log('INFO', `source "${entry.name}" reported an update (url: ${updateUrl ? 'yes' : 'no'})`);
          }
          const waiter = updateAlertWaiters.get(sourceId);
          if (waiter) {
            updateAlertWaiters.delete(sourceId);
            waiter({ log: String(data?.log || ''), updateUrl });
          }
          log('INFO', `source "${entry.name}" update alert: ${String(data?.log || '').slice(0, 200)}`);
        }
      },
    };
    compat.__getListener = (name) => listeners.get(String(name));
    return compat;
  };

  const scriptHeaderMeta = (code) => ({
    name: code.match(/@name\s+(.+)/u)?.[1]?.trim() || null,
    version: code.match(/@version\s+(.+)/u)?.[1]?.trim() || null,
    author: code.match(/@author\s+(.+)/u)?.[1]?.trim() || null,
    description: code.match(/@description\s+(.+)/u)?.[1]?.trim() || null,
  });

  const extractScriptFromJson = (text) => {
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    const found = [];
    const walk = (value) => {
      if (found.length) return;
      if (typeof value === 'string') {
        if (value.length > 120 && (value.includes('EVENT_NAMES') || value.includes('globalThis.lx') || /musicUrl/u.test(value))) found.push(value);
      } else if (Array.isArray(value)) { for (const item of value) { walk(item); if (found.length) return; } }
      else if (value && typeof value === 'object') { for (const item of Object.values(value)) { walk(item); if (found.length) return; } }
    };
    walk(data);
    return found[0] || null;
  };

  // 规范化任意输入(JS / JSON / TXT)为洛雪脚本文本。
  const normalizeScript = (rawText, label) => {
    const text = String(rawText || '').replace(/^\uFEFF/u, '').trim();
    if (!text) throw new Error('音源内容为空');
    if (text.startsWith('{') || text.startsWith('[')) {
      const inner = extractScriptFromJson(text);
      if (inner) return { code: inner.replace(/^\uFEFF/u, '').trim(), note: 'json' };
      throw new Error(`${label || 'JSON'} 中未找到洛雪音源脚本内容`);
    }
    if (text.includes('EVENT_NAMES') || text.includes('globalThis.lx') || /musicUrl/u.test(text)) {
      return { code: text, note: 'js' };
    }
    throw new Error(`${label || '文件'} 不像洛雪音源脚本(缺少 EVENT_NAMES / musicUrl)`);
  };

  const startSourceRuntime = (source) => {
    const existing = runningSources.get(source.id);
    if (existing) return existing;
    const scriptPath = path.join(scriptsDir, `${source.id}.js`);
    if (!existsSync(scriptPath)) throw new Error('音源脚本文件丢失,请更新或重新添加');
    const code = readFileSync(scriptPath, 'utf8');
    const meta = scriptHeaderMeta(code);
    const entry = {
      name: meta.name || source.name,
      version: meta.version || source.version,
      author: meta.author || source.author,
      description: meta.description || source.description,
      inited: null,
      platforms: {},
    };
    const compat = makeCompat(entry, source.id);
    const sandbox = {
      console: (() => {
        const out = {};
        for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'group', 'groupCollapsed', 'groupEnd', 'clear', 'count', 'countReset', 'assert', 'time', 'timeLog', 'timeEnd', 'timeStamp', 'profile', 'profileEnd']) {
          out[level] = (...args) => {
            if (level === 'error') log('ERROR', `[${entry.name}] ${safeFormat(args)}`);
            else if (level === 'warn') log('WARN', `[${entry.name}] ${safeFormat(args)}`);
            else if (['log', 'info', 'debug'].includes(level)) log('INFO', `[${entry.name}] ${safeFormat(args)}`);
            // 其余 console 方法(group/table/time 等)静默,避免音源脚本兼容性问题。
          };
        }
        return out;
      })(),
      setTimeout, clearTimeout, setInterval, clearInterval,
      Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
      fetch: globalThis.fetch,
      performance: globalThis.performance,
      crypto: globalThis.crypto,
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.global = sandbox;
    sandbox.lx = compat;
    vm.createContext(sandbox);
    try {
      new vm.Script(code, { filename: `lx-source-${source.id}.js` }).runInContext(sandbox, { timeout: 10000 });
    } catch (error) {
      throw new Error(`音源脚本运行失败: ${error.message}`);
    }
    const runtime = { compat, entry, sandbox, onRequest: compat.__getListener(EVENT_NAMES.request) };
    runningSources.set(source.id, runtime);
    return runtime;
  };

  const stopSourceRuntime = (id) => runningSources.delete(id);

  const probeSource = (code, fallbackName) => {
    const tempSource = { id: `probe-${randomUUID()}`, name: fallbackName || 'probe' };
    const meta = scriptHeaderMeta(code);
    // 复用 startSourceRuntime,但存到临时脚本文件,probe 后即删。
    const probeId = tempSource.id;
    const probePath = path.join(scriptsDir, `${probeId}.js`);
    writeFileSync(probePath, code, 'utf8');
    try {
      const runtime = startSourceRuntime(tempSource);
      const platforms = Object.keys(runtime.entry.platforms || {});
      if (!runtime.onRequest && !platforms.length) throw new Error('脚本未注册洛雪请求处理(on EVENT_NAMES.request)');
      return {
        meta,
        platforms: runtime.entry.platforms,
        hasRequestHandler: Boolean(runtime.onRequest),
      };
    } finally {
      try { rmSync(probePath, { force: true }); } catch { /* noop */ }
      stopSourceRuntime(probeId);
    }
  };

  // ------------------------------------------------------- local stream proxy
  // ECHO 播放器的网络栈会自动附带登录 Cookie(QQ 等域),部分流服务器会拒绝
  // 这类请求,表现为"正在加载流媒体"卡住。本机中转用干净的 Node 请求拉流,
  // 仅透传 Range(支持进度拖动),彻底隔离 Cookie 与请求头污染。
  let proxyServer = null;
  let proxyPort = 0;
  const proxyToken = randomUUID().slice(0, 8);
  // 解析代次:每次切换解析源 +1。播放 URL 内嵌解析时的代次,播放器拉流时
  // 代理发现代次过期就用"当前选中的源"重新解析并 302 —— 保证切换立即生效,
  // 即使 ECHO 命中了自己的 2 分钟 preparedMediaCache 或恢复播放。
  let resolveGeneration = Date.now();

  const upstreamHeaders = (target) => {
    const headers = { 'User-Agent': MUSIC_UA };
    if (/qqmusic\.qq\.com|y\.qq\.com/iu.test(target)) headers.Referer = 'https://y.qq.com/';
    else if (/music\.126\.net/iu.test(target)) headers.Referer = 'https://music.163.com/';
    return headers;
  };

  const pipeUpstream = (res, target, req) => {
    const headers = upstreamHeaders(target);
    if (req.headers.range) headers.Range = req.headers.range;
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    return fetch(target, { headers, signal: controller.signal, redirect: 'follow' }).then((up) => {
      const out = {};
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        if (up.headers.has(key)) out[key] = up.headers.get(key);
      }
      if (!out['content-type']) out['content-type'] = 'audio/flac';
      res.writeHead(up.status, out);
      if (!up.body) {
        res.end();
        return;
      }
      Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
    }).catch((error) => {
      log('WARN', `proxy upstream failed: ${error.message}`);
      try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('upstream failed'); } catch { /* noop */ }
    });
  };

  // 旧代次缓存链接被拉取时,用当前选中的解析源重新解析,302 到新地址。
  const reResolveForRequest = async (ticket) => {
    const request = { provider: ticket.p, providerTrackId: ticket.t, quality: ticket.q };
    if (state.mode.startsWith('lx:')) {
      const id = state.mode.slice(3);
      if (sources.some((item) => item.id === id)) {
        const fresh = await resolveViaLx(id, request);
        return fresh.url;
      }
    }
    if (state.mode === 'local' && ticket.p === 'netease') {
      const fresh = await resolveLocalNetease(request);
      return fresh.url;
    }
    if (originalResolver) {
      const fresh = await originalResolver(request);
      return fresh?.url || null;
    }
    return null;
  };

  const startStreamProxy = () => new Promise((resolve) => {
    if (proxyServer) return resolve(proxyPort);
    const server = http.createServer((req, res) => {
      try {
        const match = String(req.url || '').match(/^\/lx-[^/]+\/s\/(.+)$/u);
        if (!match) {
          res.writeHead(404);
          res.end();
          return;
        }
        let ticket;
        try {
          ticket = JSON.parse(Buffer.from(decodeURIComponent(match[1]), 'base64url').toString('utf8'));
        } catch {
          ticket = null;
        }
        if (!ticket || typeof ticket.u !== 'string' || !/^https?:\/\//iu.test(ticket.u)) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (ticket.g !== resolveGeneration) {
          // 过期代次:用当前源重新解析,重定向到新播放地址。
          reResolveForRequest(ticket).then((freshUrl) => {
            if (freshUrl && freshUrl !== req.url) {
              res.writeHead(302, { Location: freshUrl });
              res.end();
            } else {
              res.writeHead(404);
              res.end();
            }
          }).catch((error) => {
            log('WARN', `re-resolve on stale generation failed: ${error.message}`);
            try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('re-resolve failed'); } catch { /* noop */ }
          });
          return;
        }
        void pipeUpstream(res, ticket.u, req);
      } catch {
        try { res.writeHead(500); res.end(); } catch { /* noop */ }
      }
    });
    server.on('error', (error) => {
      log('WARN', `stream proxy error: ${error.message}`);
      resolve(0);
    });
    server.listen(0, '127.0.0.1', () => {
      proxyServer = server;
      proxyPort = server.address().port;
      log('INFO', `stream proxy listening on 127.0.0.1:${proxyPort}`);
      resolve(proxyPort);
    });
  });

  const toProxyTicket = (target, provider, providerTrackId, quality) => {
    if (!proxyPort) return target;
    const ticket = { u: target, p: provider, t: providerTrackId, q: quality, g: resolveGeneration };
    return `http://127.0.0.1:${proxyPort}/lx-${proxyToken}/s/${encodeURIComponent(Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url'))}`;
  };

  // --------------------------------------------------------- resolve logic

  const briefError = (message, maxLen = 160) => {
    const text = String(message || '').replace(/\s+/gu, ' ').trim();
    const jsonAt = text.indexOf('{"');
    const brief = jsonAt > 16 ? text.slice(0, jsonAt).trim() : text;
    return brief.length > maxLen ? `${brief.slice(0, maxLen)}…` : brief;
  };

  const lxCache = new Map(); // key -> { url, headers, mimeType, codec, at }
  const LX_CACHE_MS = 3 * 60 * 1000;

  const guessAudioMime = (url, fallbackQuality) => {
    const clean = String(url || '').split(/[?#]/u)[0].toLowerCase();
    if (clean.endsWith('.flac')) return { mimeType: 'audio/flac', codec: 'flac' };
    if (clean.endsWith('.mp3')) return { mimeType: 'audio/mpeg', codec: 'mp3' };
    if (clean.endsWith('.m4a') || clean.endsWith('.mp4') || clean.endsWith('.aac')) return { mimeType: 'audio/mp4', codec: 'm4a' };
    if (clean.endsWith('.ogg') || clean.endsWith('.opus')) return { mimeType: 'audio/ogg', codec: 'ogg' };
    if (clean.endsWith('.wav')) return { mimeType: 'audio/wav', codec: 'wav' };
    if (clean.endsWith('.ape')) return { mimeType: 'audio/ape', codec: 'ape' };
    return fallbackQuality === 'flac' || fallbackQuality === 'hires'
      ? { mimeType: 'audio/flac', codec: 'flac' }
      : { mimeType: 'audio/mpeg', codec: 'mp3' };
  };

  const pickLxQuality = (requested, declared) => {
    if (!Array.isArray(declared) || !declared.length) return requested;
    if (declared.includes(requested)) return requested;
    const want = LX_QUALITY_RANK[requested] ?? 2;
    const below = declared
      .filter((item) => (LX_QUALITY_RANK[item] ?? 0) <= want)
      .sort((left, right) => (LX_QUALITY_RANK[right] ?? 0) - (LX_QUALITY_RANK[left] ?? 0));
    return below[0] || declared[declared.length - 1];
  };

  const callLxMusicUrl = (sourceId, provider, providerTrackId, quality) => {
    const runtime = runningSources.get(sourceId) || startSourceRuntime(sources.find((item) => item.id === sourceId));
    const handler = runtime.onRequest;
    if (typeof handler !== 'function') throw new Error('音源脚本未注册请求处理器');
    const lxSource = PROVIDER_TO_LX[provider];
    if (!lxSource) throw new Error(`洛雪音源不支持该平台: ${provider}`);
    const wanted = QUALITY_TO_LX[quality] || 'flac';
    const declared = runtime.entry.platforms?.[lxSource]?.qualitys;
    const type = pickLxQuality(wanted, declared);
    const payload = {
      action: 'musicUrl',
      source: lxSource,
      info: { musicInfo: { songmid: providerTrackId, hash: providerTrackId, id: providerTrackId }, type },
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('洛雪音源解析超时(45s)')), 45000);
      try {
        Promise.resolve(handler(payload)).then((url) => {
          clearTimeout(timer);
          if (typeof url !== 'string' || !/^https?:\/\/\S+/iu.test(url.trim())) {
            reject(new Error('洛雪音源返回的地址无效'));
          } else resolve(url.trim());
        }, (error) => { clearTimeout(timer); reject(new Error(error?.message || String(error))); });
      } catch (error) {
        clearTimeout(timer);
        reject(new Error(error?.message || String(error)));
      }
    });
  };

  const resolveViaLx = async (sourceId, request) => {
    const provider = String(request.provider || 'netease');
    const providerTrackId = String(request.providerTrackId || '');
    const quality = String(request.quality || request.streamingQuality || 'lossless');
    if (!providerTrackId) throw new Error('缺少歌曲 ID');
    if (!proxyPort) await startStreamProxy();
    const cacheKey = `lx:${sourceId}:${provider}:${providerTrackId}:${quality}`;
    const cached = lxCache.get(cacheKey);
    if (cached && Date.now() - cached.at < LX_CACHE_MS) return cached.source;

    const providerLabel = provider === 'netease' ? '网易云' : provider === 'qqmusic' ? 'QQ' : provider;
    // 音质降级链:从请求档开始逐级下降,服务器拒绝(版权/权限)时自动降级重试。
    const lxOrder = ['master', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '128k'];
    const wanted = QUALITY_TO_LX[quality] || 'flac';
    const wantedIdx = lxOrder.indexOf(wanted);
    const chain = wantedIdx >= 0 ? lxOrder.slice(wantedIdx).reverse() : [wanted, 'flac', '320k', '128k'];

    const tried = [];
    let lastError = null;
    for (const lxQuality of chain) {
      try {
        const url = await callLxMusicUrl(sourceId, provider, providerTrackId, lxQuality);
        const audio = guessAudioMime(url, quality);
        const source = {
          provider,
          providerTrackId,
          url: toProxyTicket(url, provider, providerTrackId, quality),
          expiresAt: new Date().toISOString(),
          ...audio,
          headers: { 'User-Agent': MUSIC_UA },
          requiresProxy: false,
          supportsRange: true,
          resolvedBy: `lx:${sourceId}`,
          resolvedQuality: lxQuality,
        };
        lxCache.set(cacheKey, { source, at: Date.now() });
        if (lxQuality !== wanted) {
          const label = { hires: 'Hi-Res', flac: '无损', flac24bit: 'Hi-Res', '320k': '320k', '128k': '128k', master: '臻品母带', atmos: '全景声' }[lxQuality] || lxQuality;
          log('INFO', `quality ${wanted} unavailable for ${providerLabel} song, fell back to ${lxQuality}`);
          source.fallbackNotice = `当前音源/账号不支持 ${providerLabel} Hi-Res,已自动降级为 ${label}`;
        }
        return source;
      } catch (error) {
        lastError = error;
        tried.push(lxQuality);
      }
    }
    const names = { hires: 'Hi-Res', flac: '无损', '320k': '320k', '128k': '128k', master: '母带', atmos: '全景声', flac24bit: 'Hi-Res' };
    const triedText = tried.map((item) => names[item] || item).join(' / ');
    throw new Error(`音源未能提供这首${providerLabel}歌曲的播放地址(已尝试 ${triedText} 音质): ${briefError(lastError?.message)}`);
  };

  // 本地(公共)解析:网易,匿名(不携带账号 cookie)。
  // 优先走 Loader 自带的 NCM enhanced 库(与 bridge 未登录路径一致,内部匿名注册),
  // 失败再退回裸 HTTP API。
  const neteasePublicFetchJson = (url, timeoutMs) => new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': ECHO_UA,
        Referer: 'https://music.163.com',
      },
    }).then(async (response) => {
      clearTimeout(timer);
      const text = (await response.text()).trim();
      if (!response.ok) return reject(new Error(`http_${response.status}`));
      try { resolve(JSON.parse(text.replace(/^[^(]*\((.*)\);?$/us, '$1'))); }
      catch { reject(new Error('bad json')); }
    }, (error) => { clearTimeout(timer); reject(error); });
  });

  const ncmAnonymousApi = (() => {
    let cached = null;
    return () => {
      if (cached !== null) return cached;
      try {
        const { createRequire } = require('node:module');
        const { pathToFileURL } = require('node:url');
        const bridgeUrl = globalThis.__shinawaseBridgeUrl
          || pathToFileURL(path.join(host.loaderRoot || process.cwd(), 'streaming-bridge.cjs')).href;
        cached = createRequire(bridgeUrl)('@neteasecloudmusicapienhanced/api');
      } catch (error) {
        log('WARN', `NCM api unavailable for local mode: ${error.message}`);
        cached = false;
      }
      return cached;
    };
  })();

  const neteaseLevelsFor = (quality) => {
    const chains = {
      hires: ['hires', 'lossless', 'exhigh', 'higher', 'standard'],
      lossless: ['lossless', 'exhigh', 'higher', 'standard'],
      high: ['exhigh', 'higher', 'standard'],
      standard: ['standard'],
    };
    return chains[quality] || chains.lossless;
  };

  const sourceFromEntry = (entry, providerTrackId, fallbackLevel) => {
    const url = typeof entry?.url === 'string' ? entry.url : null;
    if (!url) return null;
    const type = String(entry.type || (String(url).includes('.flac') ? 'flac' : 'mp3')).toLowerCase();
    return {
      provider: 'netease',
      providerTrackId,
      url,
      expiresAt: new Date().toISOString(),
      mimeType: type === 'flac' ? 'audio/flac' : 'audio/mpeg',
      bitrate: Number(entry.br) || null,
      sampleRate: null,
      bitDepth: null,
      codec: type,
      headers: { 'User-Agent': MUSIC_UA, Referer: 'https://music.163.com' },
      requiresProxy: false,
      supportsRange: true,
      resolvedBy: 'local-public',
    };
  };

  const resolveLocalNetease = async (request) => {
    const providerTrackId = String(request.providerTrackId || '');
    const quality = String(request.quality || request.streamingQuality || 'lossless');
    const withTicket = (source) => {
      if (source && source.url) source.url = toProxyTicket(source.url, 'netease', providerTrackId, quality);
      return source;
    };
    const idNumber = Number(providerTrackId);
    if (!Number.isFinite(idNumber) || idNumber <= 0) throw new Error('缺少有效的网易歌曲 ID');

    const ncm = ncmAnonymousApi();
    if (ncm) {
      for (const level of neteaseLevelsFor(quality)) {
        try {
          const call = ncm.song_url_v1 || ncm.song_url;
          if (typeof call !== 'function') break;
          const response = await Promise.race([
            Promise.resolve(call.call(ncm, { id: idNumber, level })),
            new Promise((resolve, reject) => setTimeout(() => reject(new Error('ncm timeout')), 9000)),
          ]);
          const entry = Array.isArray(response?.body?.data) ? response.body.data[0] : (Array.isArray(response?.data) ? response.data[0] : null);
          const source = withTicket(sourceFromEntry(entry, providerTrackId, level));
          if (source) return source;
        } catch { /* try next level */ }
      }
    }

    // 裸 API 兜底(当前网易对无 cookie 请求普遍返回空 URL,仅留作后备)。
    const candidates = {
      hires: [{ level: 'hires', bitrate: 999000, quality: 'flac' }, { level: 'lossless', bitrate: 999000, quality: 'flac' }],
      lossless: [{ level: 'lossless', bitrate: 999000, quality: 'flac' }],
      high: [{ level: 'exhigh', bitrate: 320000, quality: 'mp3' }],
      standard: [{ level: 'standard', bitrate: 128000, quality: 'mp3' }],
    }[quality] || [{ level: 'lossless', bitrate: 999000, quality: 'flac' }];
    for (const candidate of candidates) {
      const params = new URLSearchParams({
        ids: JSON.stringify([providerTrackId]),
        level: candidate.level,
        br: String(candidate.bitrate),
        encodeType: candidate.quality === 'flac' ? 'flac' : 'mp3',
        os: 'pc',
      });
      let data = null;
      try {
        data = await neteasePublicFetchJson(`https://music.163.com/api/song/enhance/player/url/v1?${params.toString()}`, 8000);
      } catch {
        try {
          data = await neteasePublicFetchJson(`https://music.163.com/api/song/enhance/player/url?${params.toString()}`, 8000);
        } catch { continue; }
      }
      const entry = Array.isArray(data?.data) ? data.data[0] : null;
      const source = withTicket(sourceFromEntry(entry, providerTrackId, candidate.level));
      if (source) return source;
    }
    throw new Error('本地公共解析失败:该曲目可能需要账号(版权/VIP 限制),请切换到账号或其他音源');
  };

  // ------------------------------------------------------------- resolver hook

  let originalResolver = null;
  let ipcOverridden = false;

  const accountAvailable = (provider) => {
    try {
      const probe = globalThis.__shinawaseStreamingAccountCookie;
      if (typeof probe === 'function') return Boolean(probe(provider));
    } catch { /* noop */ }
    return false;
  };

  const wrappedResolver = async (request) => {
    const payload = request && typeof request === 'object' ? request : {};
    const mode = state.mode;
    if (mode.startsWith('lx:')) {
      const id = mode.slice(3);
      if (sources.some((item) => item.id === id)) {
        return resolveViaLx(id, payload);
      }
      log('WARN', `selected source ${id} missing; falling back`);
    }
    if (mode === 'local') {
      // QQ 音乐没有公共(免登录)接口,本地模式下必须明确不可用,
      // 否则会静默落到账号解析,让"本地/账号"无法区分。
      if (payload.provider !== 'netease') {
        throw new Error('本地模式仅支持网易云音乐;该平台没有公共接口,请切换到账号或其他音源');
      }
      // 匿名解析失败(VIP/版权受限)同样直接报错,不回落到账号解析。
      return await resolveLocalNetease(payload);
    }
    return originalResolver(payload);
  };

  const installResolverHook = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (typeof globalThis.__shinawaseResolveStreamingPlayback === 'function') break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (typeof globalThis.__shinawaseResolveStreamingPlayback !== 'function') {
      log('WARN', 'streaming bridge resolver not found; hook disabled');
      return false;
    }
    originalResolver = globalThis.__shinawaseResolveStreamingPlayback;
    globalThis.__shinawaseResolveStreamingPlayback = (request) => {
      try {
        const result = wrappedResolver(request);
        return result; // async
      } catch (error) {
        log('ERROR', `resolver error: ${error.message}`);
        return originalResolver(request);
      }
    };
    log('INFO', 'resolver hook installed');
    return true;
  };

  // 渲染进程显式 IPC(streaming:resolvePlayback)也经过同一包装。
  const sanitizeHeaders = (headers) => {
    if (!headers || typeof headers !== 'object') return headers;
    const cleaned = { ...headers };
    for (const key of Object.keys(cleaned)) {
      if (/cookie|authorization/iu.test(key)) delete cleaned[key];
    }
    return cleaned;
  };

  const installIpcOverride = async () => {
    if (!ipcMain || !originalResolver) return false;
    // resolver hook 就绪即代表 bridge 已完成 registerStreamingIpc(两者在同一函数里注册),
    // 因此无需等待原生 handler 出现——热重载场景原生 handler 已被上一个实例接管/移除。
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { ipcMain.removeHandler('streaming:resolvePlayback'); } catch { /* noop */ }
    ipcMain.handle('streaming:resolvePlayback', async (_event, request) => {
      const payload = request && typeof request === 'object' ? {
        provider: request.provider,
        providerTrackId: request.providerTrackId,
        quality: request.quality ?? request.streamingQuality,
        forceRefresh: request.forceRefresh === true,
      } : {};
      if (payload.forceRefresh) lxCache.clear();
      try {
        const source = await wrappedResolver(payload);
        if (source && typeof source === 'object') {
          return { ...source, headers: sanitizeHeaders(source.headers), downloadAuthorizationToken: undefined };
        }
        return source;
      } catch (error) {
        throw new Error(`LX 音源/本地解析失败: ${error.message}`);
      }
    });
    ipcOverridden = true;
    log('INFO', 'streaming:resolvePlayback IPC override installed');
    return true;
  };

  // ------------------------------------------------------------ rpc surface

  const sourceSummary = (source) => ({
    id: source.id,
    name: source.name,
    version: source.version || null,
    author: source.author || null,
    description: source.description || null,
    hasUpdate: source.hasUpdate === true,
    originKind: source.origin?.kind || 'text',
    originUrl: source.origin?.url || null,
    originPath: source.origin?.path || null,
    platforms: source.platforms && typeof source.platforms === 'object' ? Object.keys(source.platforms) : [],
    qualitys: source.qualitys && typeof source.qualitys === 'object' ? source.qualitys : {},
    createdAt: source.createdAt || null,
  });

  const downloadText = (url) => new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': MUSIC_UA },
      redirect: 'follow',
    }).then(async (response) => {
      clearTimeout(timer);
      if (!response.ok) return reject(new Error(`下载失败: HTTP ${response.status}`));
      resolve(await response.text());
    }, (error) => { clearTimeout(timer); reject(new Error(`下载失败: ${error.message}`)); });
  });

  const saveSourceScript = (id, code) => {
    try { mkdirSync(scriptsDir, { recursive: true }); } catch { /* noop */ }
    writeFileSync(path.join(scriptsDir, `${id}.js`), code, 'utf8');
  };

  const registerSource = ({ code, origin, fallbackName, allowMerge = true }) => {
    const probe = probeSource(code, fallbackName);
    const meta = probe.meta || {};
    const record = {
      id: `lx-${createHash('md5').update(code).digest('hex').slice(0, 12)}`,
      name: meta.name || fallbackName || '未命名洛雪音源',
      version: meta.version || null,
      author: meta.author || null,
      description: meta.description || null,
      origin,
      platforms: probe.platforms || {},
      qualitys: Object.fromEntries(Object.entries(probe.platforms || {}).map(([key, value]) => [key, value.qualitys || []])),
      createdAt: new Date().toISOString(),
    };
    const existingIndex = sources.findIndex((item) => item.id === record.id);
    if (existingIndex >= 0) {
      if (!allowMerge) throw new Error(`该脚本内容与已有音源「${sources[existingIndex].name}」相同,请先删除或换一个来源`);
      sources[existingIndex] = { ...sources[existingIndex], ...record, name: record.name === '未命名洛雪音源' ? sources[existingIndex].name : record.name };
    }
    else sources.push(record);
    saveSourceScript(record.id, code);
    persistSources();
    return record;
  };

  const methods = {
    async getState() {
      return {
        mode: state.mode,
        sources: sources.map(sourceSummary),
        accounts: {
          netease: accountAvailable('netease'),
          qqmusic: accountAvailable('qqmusic'),
        },
        hookReady: Boolean(originalResolver),
        ipcOverridden,
      };
    },
    async setMode(payload) {
      const mode = String(payload?.mode || '');
      if (!['local', 'account'].includes(mode) && !mode.startsWith('lx:')) throw new Error('无效的解析源');
      if (mode.startsWith('lx:') && !sources.some((item) => item.id === mode.slice(3))) throw new Error('音源不存在');
      state.mode = mode;
      resolveGeneration += 1;
      lxCache.clear();
      persistState();
      notifyRenderer('mode-changed', { mode });
      log('INFO', `resolve mode -> ${mode} (generation ${resolveGeneration})`);
      return { ok: true, mode: state.mode };
    },
    async addSource(payload) {
      let code;
      let origin;
      let fallbackName = null;
      if (payload?.url) {
        const url = String(payload.url).trim();
        if (!/^https?:\/\//iu.test(url)) throw new Error('URL 必须以 http(s):// 开头');
        const text = await downloadText(url);
        ({ code } = normalizeScript(text, url));
        origin = { kind: 'url', url };
        fallbackName = null;
      } else if (payload?.dataBase64) {
        const raw = Buffer.from(String(payload.dataBase64), 'base64').toString('utf8');
        const fileName = String(payload.name || '').trim() || null;
        const normalized = normalizeScript(raw, fileName || '文件');
        code = normalized.code;
        origin = { kind: 'file', path: payload.originPath || fileName || null };
        fallbackName = fileName ? fileName.replace(/\.(js|json|txt)$/iu, '') : null;
      } else {
        throw new Error('请提供音源 URL 或文件内容');
      }
      const record = registerSource({ code, origin, fallbackName });
      try { startSourceRuntime(record); } catch (error) { log('WARN', `warm-up failed: ${error.message}`); }
      notifyRenderer('sources-changed', {});
      log('INFO', `source added: ${record.name} (${record.id})`);
      return { ok: true, source: sourceSummary(record) };
    },
    async updateSource(payload) {
      const id = String(payload?.id || '');
      const record = sources.find((item) => item.id === id);
      if (!record) throw new Error('音源不存在');
      // 手动更新不受每日节流限制,并视为今天已完成检测。
      markUpdateChecked();
      const applyDownloaded = (code, note) => {
        stopSourceRuntime(id);
        const updated = registerSource({ code, origin: record.origin, fallbackName: record.name });
        record.hasUpdate = false;
        persistSources();
        if (updated.id !== id) {
          // registerSource 已把新记录加入列表,这里只需移除旧记录。
          sources = sources.filter((item) => item.id !== id);
          persistSources();
          if (state.mode === `lx:${id}`) { state.mode = `lx:${updated.id}`; persistState(); }
        } else {
          try { startSourceRuntime(updated); } catch { /* noop */ }
        }
        notifyRenderer('sources-changed', {});
        const version = updated.version ? `v${normalizeVersion(updated.version)}` : '新版本';
        return { ok: true, updated: true, message: `已更新到 ${version}${note ? `（${note}）` : ''}`, source: sourceSummary(updated) };
      };
      const sameContent = (code) => `lx-${createHash('md5').update(code).digest('hex').slice(0, 12)}` === id
        || normalizeVersion(scriptHeaderMeta(code).version) === normalizeVersion(record.version) && Boolean(record.version);

      // 1) 主动检测:重启音源运行时,让脚本自带的 checkUpdate 重新跑一遍并等待上报。
      stopSourceRuntime(id);
      const alertPromise = new Promise((resolve) => updateAlertWaiters.set(id, resolve));
      let runtimeStarted = false;
      try {
        startSourceRuntime(record);
        runtimeStarted = true;
      } catch (error) {
        updateAlertWaiters.delete(id);
        throw error;
      }
      let alert = null;
      try {
        alert = await Promise.race([alertPromise, delay(18000).then(() => null)]);
      } finally {
        updateAlertWaiters.delete(id);
      }
      if (alert?.updateUrl && /^https?:\/\//iu.test(alert.updateUrl)) {
        const text = await downloadText(alert.updateUrl);
        const { code } = normalizeScript(text, '音源更新包');
        if (sameContent(code)) {
          record.hasUpdate = false;
          persistSources();
          notifyRenderer('sources-changed', {});
          return { ok: true, updated: false, message: '检测到更新通道,但内容与当前版本一致,已是最新版本', source: sourceSummary(record) };
        }
        return applyDownloaded(code, '来自音源自报更新');
      }
      if (runtimeStarted && alert === null) {
        const checkFailed = runningSources.get(id)?.entry?.updateCheckFailed === true;
        if (checkFailed) {
          return { ok: false, updated: false, error: '无法连接音源的更新服务器,请稍后再试' };
        }
        if (!record.origin?.url) {
          return { ok: true, updated: false, message: '已是最新版本(音源自检未发现新版本)' };
        }
      }

      // 2) URL 来源:重新下载脚本,对比版本后决定是否应用。
      const origin = record.origin || {};
      if (origin.kind === 'url' && origin.url && /^https?:\/\//iu.test(origin.url)) {
        const text = await downloadText(origin.url);
        const { code } = normalizeScript(text, origin.url);
        if (sameContent(code)) {
          record.hasUpdate = false;
          persistSources();
          notifyRenderer('sources-changed', {});
          return { ok: true, updated: false, message: '已是最新版本', source: sourceSummary(record) };
        }
        return applyDownloaded(code, '来自来源 URL');
      }

      // 3) 本地文件:重读文件内容对比。
      if (origin.kind === 'file' && origin.path && existsSync(origin.path)) {
        const raw = readFileSync(origin.path, 'utf8');
        const { code } = normalizeScript(raw, origin.path);
        if (sameContent(code)) {
          return { ok: true, updated: false, message: '已是最新版本', source: sourceSummary(record) };
        }
        return applyDownloaded(code, '来自本地文件');
      }
      return { ok: true, updated: false, message: '已是最新版本(音源自检未发现新版本)' };
    },
    async editSource(payload) {
      const id = String(payload?.id || '');
      const record = sources.find((item) => item.id === id);
      if (!record) throw new Error('音源不存在');
      if (payload?.name != null) {
        const name = String(payload.name).trim();
        if (name) record.name = name;
      }
      const newUrl = typeof payload?.url === 'string' && /^https?:\/\//iu.test(payload.url.trim()) ? payload.url.trim() : null;
      const hasFile = typeof payload?.dataBase64 === 'string' && payload.dataBase64.length > 0;
      let updated = null;
      if (newUrl || hasFile) {
        let code;
        let origin;
        if (newUrl && !hasFile) {
          // 把音源切换为该 URL:下载内容应用,更新来源也随之变为这个 URL。
          const text = await downloadText(newUrl);
          code = normalizeScript(text, newUrl).code;
          origin = { kind: 'url', url: newUrl };
        } else {
          const raw = Buffer.from(String(payload.dataBase64), 'base64').toString('utf8');
          code = normalizeScript(raw, '编辑').code;
          origin = { kind: 'file', path: payload.originPath || record.origin?.path || null };
        }
        stopSourceRuntime(id);
        updated = registerSource({ code, origin, fallbackName: record.name, allowMerge: false });
        record.hasUpdate = false;
        persistSources();
        if (updated.id !== id) {
          // registerSource 已把新记录加入列表,这里只需移除旧记录。
          sources = sources.filter((item) => item.id !== id);
          persistSources();
          if (state.mode === `lx:${id}`) { state.mode = `lx:${updated.id}`; persistState(); }
        } else {
          try { startSourceRuntime(updated); } catch { /* noop */ }
        }
      } else {
        persistSources();
      }
      notifyRenderer('sources-changed', {});
      const current = sources.find((item) => item.id === (updated ? updated.id : id)) || record;
      return { ok: true, source: sourceSummary(current) };
    },
    async deleteSource(payload) {
      const id = String(payload?.id || '');
      const before = sources.length;
      sources = sources.filter((item) => item.id !== id);
      if (sources.length === before) throw new Error('音源不存在');
      stopSourceRuntime(id);
      try { rmSync(path.join(scriptsDir, `${id}.js`), { force: true }); } catch { /* noop */ }
      if (state.mode === `lx:${id}`) { state.mode = 'local'; persistState(); }
      persistSources();
      notifyRenderer('sources-changed', {});
      log('INFO', `source deleted: ${id}`);
      return { ok: true, mode: state.mode };
    },
    async probeText(payload) {
      const raw = Buffer.from(String(payload?.dataBase64 || ''), 'base64').toString('utf8');
      const { code } = normalizeScript(raw, payload?.name || '内容');
      const probe = probeSource(code, null);
      return {
        ok: true,
        meta: probe.meta,
        platforms: Object.fromEntries(Object.entries(probe.platforms || {}).map(([key, value]) => [key, { name: value.name, qualitys: value.qualitys }])),
      };
    },
  };

  for (const [name, handler] of Object.entries(methods)) {
    host.handle(`lxResolver.${name}`, async (payload) => handler(payload));
  }

  // ------------------------------------------------- streaming mod patch
  // 最近搜索的删除/清空必须改动 ECHO Streaming 模块的内存状态并触发它的
  // 重渲染,外部注入做不到。这里给它的 mod.js 打一个自愈式补丁(带版本,
  // 从 .bak 原始文件重新打,音源更新覆盖后下次激活自动恢复)。
  const patchStreamingRecentSearches = () => {
    try {
      const target = path.join(host.echoRoot || gameRootFallback(), 'Mods', 'installed', 'echo.community-streaming', 'mod.js');
      if (!existsSync(target)) return;
      const bak = target + '.bak';
      const base = existsSync(bak) ? readFileSync(bak, 'utf8') : readFileSync(target, 'utf8');
      if (base.includes('streaming-recent-patch-v2')) return;
      const styleId = "{ const patchStyle = document.getElementById('streaming-recent-del-style') || document.createElement('style'); patchStyle.id = 'streaming-recent-del-style'; patchStyle.textContent = '.streaming-recent-searches>div:first-child{display:flex;align-items:center}.streaming-recent-searches>div:first-child .streaming-recent-clear{margin-left:auto;margin-right:2px;cursor:pointer;opacity:.55;font-size:11px;user-select:none}.streaming-recent-searches>div:first-child .streaming-recent-clear:hover{opacity:1;color:#fca5a5}.streaming-recent-searches button{position:relative;padding-right:30px}.streaming-recent-searches .streaming-recent-del{position:absolute;right:9px;top:50%;transform:translateY(-50%);width:18px;height:18px;line-height:16px;text-align:center;border-radius:50%;opacity:0;cursor:pointer;font-size:13px;color:#cbd5e1;background:rgba(255,255,255,.08);transition:opacity .15s;user-select:none;z-index:2}.streaming-recent-searches button:hover .streaming-recent-del{opacity:.85}.streaming-recent-searches .streaming-recent-del:hover{opacity:1!important;background:rgba(248,113,113,.4);color:#fff}'; if (!patchStyle.isConnected) document.head.append(patchStyle); }";
      const headingAnchor = "  recentHeading.append(make('span', '', copy.recentSearches), make('small', '', String(state.recentSearches.length)));";
      if (!headingAnchor || !base.includes(headingAnchor)) {
        log('WARN', 'streaming recent-search heading anchor missing; patch skipped');
        return;
      }
      const chipAnchor = "    chip.replaceChildren(makeIcon('search', 13), make('span', '', value));";
      if (!base.includes(chipAnchor)) {
        log('WARN', 'streaming recent-search chip anchor missing; patch skipped');
        return;
      }
      // 会话内删除集合:渲染时把被删词滤掉;刚搜索过的词(首位)自动恢复。
      const sessionFilter = "  { if (window.__lxDeletedSearches && window.__lxDeletedSearches.size && state.recentSearches.length && window.__lxDeletedSearches.has(state.recentSearches[0])) { window.__lxDeletedSearches.delete(state.recentSearches[0]); } if (window.__lxDeletedSearches && window.__lxDeletedSearches.size) { state.recentSearches = state.recentSearches.filter((item, idx) => idx === 0 || !window.__lxDeletedSearches.has(item)); } }";
      const headingPatch = headingAnchor + '\n' + styleId + '\n' + [
        "  {",
        "    const recentClear = make('span', '', '清空');",
        "    recentClear.className = 'streaming-recent-clear';",
        "    recentClear.addEventListener('click', (ev) => {",
        "      ev.stopPropagation();",
        "      window.__lxDeletedSearches = new Set([...(window.__lxDeletedSearches || []), ...state.recentSearches]);",
        "      state.recentSearches = [];",
        "      persistMemory();",
        "      render();",
        "    });",
        "    const countBadge = recentHeading.querySelector('small');",
        "    if (countBadge) recentHeading.insertBefore(recentClear, countBadge);",
        "    else recentHeading.append(recentClear);",
        "  }",
      ].join('\n');
      const chipPatch = chipAnchor + '\n' + [
        "    {",
        "      const recentDel = make('span', '', '×');",
        "      recentDel.className = 'streaming-recent-del';",
        "      recentDel.addEventListener('click', (ev) => {",
        "        ev.stopPropagation();",
        "        ev.preventDefault();",
        "        window.__lxDeletedSearches = new Set(window.__lxDeletedSearches || []);",
        "        window.__lxDeletedSearches.add(value);",
        "        state.recentSearches = state.recentSearches.filter((item) => item !== value);",
        "        persistMemory();",
        "        render();",
        "      });",
        "      chip.append(recentDel);",
        "    }",
      ].join('\n');
      // session filter runs right before the recent-search list is rendered
      const recentAnchor = "  const recent = make('div', 'streaming-recent-searches');";
      if (!base.includes(recentAnchor)) {
        log('WARN', 'streaming recent container anchor missing; patch skipped');
        return;
      }
      let next = base
        .replace(recentAnchor, sessionFilter + '\n' + recentAnchor)
        .replace(headingAnchor, headingPatch)
        .replace(chipAnchor, chipPatch);
      if (!existsSync(bak)) writeFileSync(bak, base, 'utf8');
      if (next === readFileSync(target, 'utf8')) return;
      writeFileSync(target, next, 'utf8');
      log('INFO', 'streaming mod recent-search patch v2 applied');
    } catch (error) {
      log('WARN', `streaming patch failed: ${error.message}`);
    }
  };

  // 音源运行时启动:脚本初始化时会自带每日一次的更新自检。
  for (const record of sources) {
    try { startSourceRuntime(record); } catch (error) { log('WARN', `source "${record.name}" failed to start: ${error.message}`); }
  }

  void startStreamProxy();
  patchStreamingRecentSearches();

  const disposeHookWatch = (() => {
    let cancelled = false;
    void (async () => {
      const ok = await installResolverHook();
      if (ok && !cancelled) await installIpcOverride();
    })();
    return () => { cancelled = true; };
  })();

  log('INFO', `activated with ${sources.length} source(s), mode=${state.mode}`);

  return () => {
    disposeHookWatch();
    if (originalResolver) {
      try { globalThis.__shinawaseResolveStreamingPlayback = originalResolver; } catch { /* noop */ }
    }
    // IPC handler 保留:原生 handler 已不可恢复,保留的 handler 闭包仍指向
    // 原生 resolver(等同默认行为);下一次 activate 会重新接管。
    runningSources.clear();
    if (proxyServer) {
      try { proxyServer.close(); } catch { /* noop */ }
      proxyServer = null;
      proxyPort = 0;
    }
    log('INFO', 'deactivated');
  };
};

function gameRootFallback() {
  try {
    const candidate = path.join(process.env.ECHO_GAME_ROOT || '', '');
    if (candidate && candidate.length > 3) return candidate;
  } catch { /* noop */ }
  return process.cwd();
}

function joinUserDir(app, segment) {
  let base;
  try { base = app?.getPath?.('userData'); } catch { base = null; }
  if (!base) base = process.env.APPDATA || process.cwd();
  return path.join(base, segment);
}

function safeFormat(args) {
  return args.map((item) => {
    if (typeof item === 'string') return item;
    try { return JSON.stringify(item); } catch { return String(item); }
  }).join(' ');
}
