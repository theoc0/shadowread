#!/usr/bin/env node
/**
 * ShadowTalk — 影子跟讀（Shadowing）後端
 * 零依賴：只用 Node.js 內建模組。
 *
 * 功能：
 *  - 靜態托管 public/（前端）
 *  - POST /api/deepseek           → 代理 DeepSeek（隱藏 API key）
 *  - GET  /api/youtube/tracks     → 列出影片字幕軌
 *  - GET  /api/youtube/transcript → 抓取 YouTube 字幕
 *  - GET  /api/bilibili/subtitle  → 抓取 Bilibili 字幕（含 WBI 簽名）
 *
 * 啟動：node server.js  →  http://localhost:8787
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8787', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || 'sk-f91785e819fb4d99a48f243ebee7496d';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------- cookie jar（按域名隔離） ----------
const cookieJars = {};
function getCookies(host) { return cookieJars[host] || ''; }
function storeCookies(host, setCookieArr) {
  const jar = cookieJars[host] || (cookieJars[host] = '');
  for (const c of setCookieArr || []) {
    const kv = c.split(';')[0];
    const name = kv.split('=')[0];
    if (!jar.includes(name + '=')) cookieJars[host] = jar ? jar + '; ' + kv : kv;
  }
}

// ---------- 通用 HTTP 請求（跟隨重定向 + 自動解壓） ----------
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', headers = {}, body = null, redirects = 8 } = opts;
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('無效網址')); }
    const reqHeaders = {
      'User-Agent': UA,
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      ...headers
    };
    const jarCookie = getCookies(u.hostname);
    if (jarCookie) reqHeaders['Cookie'] = jarCookie;
    if (body != null) {
      reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: reqHeaders }, (res) => {
      storeCookies(u.hostname, res.headers['set-cookie']);
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(request(next, { method, headers, body, redirects: redirects - 1 }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
          else if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
        } catch (_) { /* 忽略解壓失敗 */ }
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), finalUrl: url });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('請求超時')); });
    if (body != null) req.write(body);
    req.end();
  });
}

function json(res, code, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(data);
}

function decodeEntities(s) {
  let prev;
  do {
    prev = s;
    s = s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  } while (s !== prev);
  return s;
}

// ---------- YouTube ----------
function parseYoutubeId(input) {
  const s = String(input || '');
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function getYoutubeInnertubeKey(videoId) {
  const res = await request('https://www.youtube.com/watch?v=' + videoId, {
    headers: { 'Cookie': 'CONSENT=YES+cb; SOCS=CAI' }
  });
  const m = res.text.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (!m) throw new Error('無法取得 YouTube API 金鑰（影片可能受限、地區限制或需登入）');
  return m[1];
}

async function getYoutubeCaptionTracks(videoId) {
  const key = await getYoutubeInnertubeKey(videoId);
  const res = await request('https://www.youtube.com/youtubei/v1/player?key=' + key, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
      videoId
    })
  });
  let j;
  try { j = JSON.parse(res.text); } catch (_) { j = {}; }
  const tracks = (j && j.captions && j.captions.playerCaptionsTracklistRenderer &&
    j.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
  return tracks.map((t) => ({
    code: t.languageCode,
    name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode,
    kind: t.kind || '',
    url: t.baseUrl
  }));
}

function parseTimedTextXml(xml) {
  const re = /<\s*text\b([^>]*)>([\s\S]*?)<\s*\/text\s*>/g;
  const segs = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const start = parseFloat((attrs.match(/start="([\d.]+)"/) || [])[1] || '0');
    const dur = parseFloat((attrs.match(/dur="([\d.]+)"/) || [])[1] || '0');
    const text = decodeEntities(m[2].replace(/\s+/g, ' ')).trim();
    if (text) segs.push({ start, end: +(start + dur).toFixed(3), text });
  }
  return segs;
}

async function fetchYoutubeTranscript(videoId, lang) {
  const tracks = await getYoutubeCaptionTracks(videoId);
  if (!tracks.length) throw new Error('此影片沒有可用字幕（可能是無字幕影片）');
  let track = tracks.find((t) => t.code === lang) ||
    tracks.find((t) => t.code === (lang || '').split('-')[0]) ||
    tracks.find((t) => t.kind !== 'asr') ||
    tracks[0];
  let baseUrl = track.url.replace(/&fmt=[^&]+/, '');
  const res = await request(baseUrl);
  if (res.status !== 200) throw new Error('字幕下載失敗');
  const segments = parseTimedTextXml(res.text);
  if (!segments.length) throw new Error('字幕解析為空');
  return { segments, lang: track.code, tracks };
}

// ---------- Bilibili ----------
const WBI_MIXIN_KEY_ENC_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
function wbiMixinKey(orig) { return WBI_MIXIN_KEY_ENC_TAB.map((i) => orig[i]).join('').slice(0, 32); }
function wbiFilterChar(s) { return String(s).split('').filter((c) => "!'()*".indexOf(c) === -1).join(''); }

function parseBvid(input) {
  const m = String(input || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[1] : null;
}

async function resolveFinalUrl(input) {
  let url = String(input || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  // 對短鏈（b23.tv 等）先跟隨重定向拿最終網址
  const head = await request(url, { method: 'GET', headers: { Range: 'bytes=0-0' } }).catch(() => null);
  return head ? head.finalUrl : url;
}

async function getWbiKeys() {
  const nav = await request('https://api.bilibili.com/x/web-interface/nav', {});
  let imgKey = '', subKey = '';
  try {
    const j = JSON.parse(nav.text);
    imgKey = ((j.data && j.data.wbi_img && j.data.wbi_img.img_url) || '').split('/').pop().split('.')[0];
    subKey = ((j.data && j.data.wbi_img && j.data.wbi_img.sub_url) || '').split('/').pop().split('.')[0];
  } catch (_) { /* 忽略 */ }
  return { imgKey, subKey, mixin: wbiMixinKey(imgKey + subKey) };
}

async function getBilibiliCid(bvid) {
  // 方法一：view API
  try {
    const v = await request('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
      headers: { 'Referer': 'https://www.bilibili.com/' }
    });
    const j = JSON.parse(v.text);
    if (j.code === 0 && j.data) {
      const cid = (j.data.pages && j.data.pages[0] && j.data.pages[0].cid) || j.data.cid;
      if (cid) return { cid: String(cid), title: j.data.title || '' };
    }
  } catch (_) { /* 忽略，走網頁解析 */ }
  // 方法二：直接從影片頁 HTML 解析
  const page = await request('https://www.bilibili.com/video/' + bvid, {});
  const cidM = page.text.match(/"cid":(\d+)/);
  const titleM = page.text.match(/<title[^>]*>([^<]*)<\/title>/);
  const cid = cidM ? cidM[1] : null;
  let title = titleM ? titleM[1] : '';
  title = title.replace(/[_-](哔哩哔哩|bilibili).*$/i, '').replace(/_哔哩哔哩.*$/, '').trim();
  if (!cid) throw new Error('無法取得影片分 P 資訊（可能被風控，請稍後重試）');
  return { cid, title };
}

async function getBilibiliSubtitles(bvid, cid) {
  const { mixin } = await getWbiKeys();
  // 方法一：wbi/v2
  const wts = Math.floor(Date.now() / 1000);
  const params = { bvid, cid: String(cid), wts: String(wts) };
  const qs = Object.keys(params).sort()
    .map((k) => k + '=' + encodeURIComponent(wbiFilterChar(params[k])))
    .join('&');
  const w_rid = crypto.createHash('md5').update(qs + mixin).digest('hex');
  const urls = [
    `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}&w_rid=${w_rid}&wts=${wts}`,
    `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`
  ];
  for (const u of urls) {
    try {
      const r = await request(u, { headers: { 'Referer': 'https://www.bilibili.com/video/' + bvid } });
      const j = JSON.parse(r.text);
      const subs = (j && j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
      if (subs.length) return subs.map((s) => ({ lan: s.lan, lan_doc: s.lan_doc, url: s.subtitle_url }));
    } catch (_) { /* 換下一個 */ }
  }
  return [];
}

async function fetchBilibiliSubtitle(input, lang) {
  await request('https://www.bilibili.com/', {}).catch(() => {}); // 拿 buvid3 cookie
  const finalUrl = await resolveFinalUrl(input);
  const bvid = parseBvid(finalUrl);
  if (!bvid) throw new Error('無法從鏈接解析 BV 號');
  const { cid, title } = await getBilibiliCid(bvid);
  const subs = await getBilibiliSubtitles(bvid, cid);
  if (!subs.length) throw new Error('此影片沒有上傳字幕（CC）。可改用「上傳字幕檔」或「貼上文本」');
  let chosen = subs.find((s) => s.lan === lang) ||
    subs.find((s) => (s.lan || '').toLowerCase().startsWith((lang || '').split('-')[0].toLowerCase())) ||
    subs[0];
  const su = chosen.url.startsWith('//') ? 'https:' + chosen.url : chosen.url;
  const r = await request(su, {});
  const j = JSON.parse(r.text);
  const segments = (j.body || []).map((b) => ({ start: +b.from, end: +b.to, text: String(b.content || '').trim() })).filter((s) => s.text);
  if (!segments.length) throw new Error('字幕內容為空');
  return { title, bvid, cid, segments, lang: chosen.lan, subtitles: subs.map((s) => ({ lan: s.lan, lan_doc: s.lan_doc })) };
}

// ---------- DeepSeek ----------
async function callDeepSeek(payload) {
  const body = JSON.stringify({
    model: payload.model || DEEPSEEK_MODEL,
    messages: payload.messages,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.3,
    max_tokens: payload.max_tokens || 2048,
    stream: false,
    ...(payload.response_format ? { response_format: payload.response_format } : {})
  });
  const res = await request(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + DEEPSEEK_KEY
    },
    body
  });
  if (res.status !== 200) throw new Error('DeepSeek 錯誤 ' + res.status + ': ' + res.text.slice(0, 300));
  return JSON.parse(res.text);
}

// ---------- 伺服器 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(reqUrl.pathname);

  try {
    // ---- API ----
    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, model: DEEPSEEK_MODEL });
    }

    if (pathname === '/api/deepseek' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload;
      try { payload = JSON.parse(body); } catch (_) { return json(res, 400, { error: '無效 JSON' }); }
      try {
        const result = await callDeepSeek(payload);
        return json(res, 200, result);
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (pathname === '/api/youtube/tracks') {
      const videoId = parseYoutubeId(reqUrl.searchParams.get('videoId') || reqUrl.searchParams.get('url'));
      if (!videoId) return json(res, 400, { error: '無法解析 YouTube 影片 ID' });
      try {
        const tracks = await getYoutubeCaptionTracks(videoId);
        return json(res, 200, { tracks });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }

    if (pathname === '/api/youtube/transcript') {
      const videoId = parseYoutubeId(reqUrl.searchParams.get('videoId') || reqUrl.searchParams.get('url'));
      const lang = reqUrl.searchParams.get('lang') || 'en';
      if (!videoId) return json(res, 400, { error: '無法解析 YouTube 影片 ID' });
      try {
        const data = await fetchYoutubeTranscript(videoId, lang);
        return json(res, 200, data);
      } catch (e) { return json(res, 502, { error: e.message }); }
    }

    if (pathname === '/api/bilibili/resolve') {
      const url = reqUrl.searchParams.get('url') || '';
      if (!url) return json(res, 400, { error: '缺少鏈接' });
      try {
        await request('https://www.bilibili.com/', {}).catch(() => {});
        const finalUrl = await resolveFinalUrl(url);
        const bvid = parseBvid(finalUrl);
        if (!bvid) return json(res, 400, { error: '無法解析 BV 號' });
        const { cid, title } = await getBilibiliCid(bvid);
        return json(res, 200, { bvid, cid, title });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }

    if (pathname === '/api/bilibili/subtitle') {
      const url = reqUrl.searchParams.get('url') || '';
      const lang = reqUrl.searchParams.get('lang') || '';
      if (!url) return json(res, 400, { error: '缺少鏈接' });
      try {
        const data = await fetchBilibiliSubtitle(url, lang);
        return json(res, 200, data);
      } catch (e) { return json(res, 502, { error: e.message }); }
    }

    // ---- 靜態文件 ----
    let filePath = pathname === '/' ? '/index.html' : pathname;
    const full = path.normalize(path.join(PUBLIC_DIR, filePath));
    if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { error: '禁止訪問' });
    fs.readFile(full, (err, data) => {
      if (err) {
        // SPA 回退到 index.html
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) return json(res, 404, { error: 'Not found' });
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
        });
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│  ShadowTalk 影子跟讀 已啟動                    │');
  console.log('│  開啟瀏覽器訪問：http://localhost:' + PORT + '         │');
  console.log('└─────────────────────────────────────────────┘');
});
