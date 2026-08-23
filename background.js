const STREAMS_KEY = 'vsc_streams_by_tab';
const TASKS_KEY = 'vsc_download_tasks';
const DEBUG_KEY = 'vsc_debug_log';
const MAX_ITEMS = 80;
const MAX_DEBUG = 500;
let offscreenCreating = null;

const now = () => Date.now();

function redactString(value) {
  const s = String(value ?? '');
  if (!/^https?:\/\//i.test(s)) return s;
  return s
    .replace(/((?:hmac|pathsig|token|sig|signature|jwt|auth|key|acl|psid)=)([^~/?&#]+)/gi, '$1<redacted>')
    .replace(/([?&](?:hmac|pathsig|token|sig|signature|jwt|auth|key|acl|psid)=)[^&]+/gi, '$1<redacted>');
}
function redactData(value, depth = 0) {
  if (depth > 5) return '[max-depth]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(v => redactData(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactData(v, depth + 1);
    return out;
  }
  return value;
}

async function clearTransientDiagnostics() {
  try { await chrome.storage.local.remove(DEBUG_KEY); } catch (_) {}
}

async function debugLog(level, event, data = {}) {
  try {
    const d = await chrome.storage.local.get(DEBUG_KEY);
    const logs = Array.isArray(d[DEBUG_KEY]) ? d[DEBUG_KEY] : [];
    logs.push({ ts: new Date().toISOString(), level, event, data: redactData(data) });
    if (logs.length > MAX_DEBUG) logs.splice(0, logs.length - MAX_DEBUG);
    await chrome.storage.local.set({ [DEBUG_KEY]: logs });
  } catch (_) {}
}

function classifyUrl(url, contentType = '') {
  const u = String(url || '');
  const ct = String(contentType || '').toLowerCase();
  if (!/^https?:\/\//i.test(u)) return null;
  if (/\.m3u8(?:[?#]|$)/i.test(u) || ct.includes('mpegurl')) return { type: 'hls', rank: 100, label: 'HLS' };
  if (/\.(?:vtt|srt)(?:[?#]|$)/i.test(u) || ct.includes('text/vtt') || ct.includes('subrip')) return { type: 'subtitle', rank: 65, label: 'כתוביות' };
  if (/\.mpd(?:[?#]|$)/i.test(u) || ct.includes('dash+xml')) return { type: 'dash', rank: 80, label: 'DASH' };
  if (/player\.vimeo\.com\/video\/\d+/i.test(u)) return { type: 'player', rank: 50, label: 'נגן וידאו' };
  if (/\.mp4(?:[?#]|$)/i.test(u) || ct.startsWith('video/mp4')) {
    const fragment = /\/v2\/range\/prot\//i.test(u) || /[?&]range=\d+-\d+/i.test(u);
    return fragment ? { type: 'fragment', rank: 15, label: 'מקטע MP4' } : { type: 'mp4', rank: 110, label: 'MP4' };
  }
  return null;
}

function expiresAt(url) {
  const m = String(url).match(/(?:^|[\/~?&])exp=(\d{9,12})(?:[~&/?]|$)/i);
  return m ? Number(m[1]) * 1000 : null;
}

async function getStreamsStore() {
  const d = await chrome.storage.local.get(STREAMS_KEY);
  return d[STREAMS_KEY] || {};
}

async function putStreamsStore(store) {
  await chrome.storage.local.set({ [STREAMS_KEY]: store });
}

async function clearStreamsForTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const store = await getStreamsStore();
  delete store[String(tabId)];
  await putStreamsStore(store);
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

function notifyTabContextChanged(data) {
  chrome.runtime.sendMessage({ target: 'ui', type: 'tabContextChanged', ...data }).catch(() => {});
}

function stableKey(item) {
  if (item.type === 'fragment') {
    const m = item.url.match(/\/avf\/([0-9a-f-]+)\.mp4/i);
    if (m) return `fragment:${m[1]}`;
  }
  return `${item.type}:${item.url}`;
}

async function addStream(tabId, raw) {
  if (!Number.isInteger(tabId) || tabId < 0 || !raw?.url) return;
  const cls = classifyUrl(raw.url, raw.contentType);
  if (!cls && !raw.type) return;
  const item = {
    url: raw.url,
    type: raw.type || cls.type,
    label: raw.label || cls?.label || raw.type,
    rank: raw.rank ?? cls?.rank ?? 1,
    quality: raw.quality || '',
    width: Number(raw.width || 0),
    height: Number(raw.height || 0),
    fps: Number(raw.fps || 0),
    bitrate: Number(raw.bitrate || 0),
    title: raw.title || '',
    duration: Number(raw.duration || 0),
    thumbnail: raw.thumbnail || '',
    language: raw.language || '',
    subtitleKind: raw.subtitleKind || raw.kind || '',
    source: raw.source || 'network',
    contentType: raw.contentType || '',
    statusCode: raw.statusCode || null,
    expiry: raw.expiry || expiresAt(raw.url),
    seenAt: now()
  };

  const store = await getStreamsStore();
  const key = String(tabId);
  const list = Array.isArray(store[key]) ? store[key] : [];
  const sk = stableKey(item);
  const idx = list.findIndex(x => stableKey(x) === sk);
  if (idx >= 0) list[idx] = { ...list[idx], ...item };
  else list.push(item);
  list.sort((a, b) => (b.rank - a.rank) || (b.height - a.height) || (b.seenAt - a.seenAt));
  store[key] = list.slice(0, MAX_ITEMS);
  await putStreamsStore(store);

  const useful = store[key].filter(x => ['mp4', 'hls'].includes(x.type)).length;
  await chrome.action.setBadgeText({ tabId, text: useful ? String(Math.min(useful, 9)) : '' }).catch(() => {});
}

chrome.webRequest.onBeforeRequest.addListener(
  d => addStream(d.tabId, { url: d.url, source: 'network' }).catch(() => {}),
  { urls: ['https://*.vimeo.com/*', 'https://*.vimeocdn.com/*'] }
);

chrome.webRequest.onResponseStarted.addListener(
  d => {
    const ct = (d.responseHeaders || []).find(h => String(h.name).toLowerCase() === 'content-type')?.value || '';
    addStream(d.tabId, { url: d.url, source: 'network', contentType: ct, statusCode: d.statusCode }).catch(() => {});
  },
  { urls: ['https://*.vimeo.com/*', 'https://*.vimeocdn.com/*'] },
  ['responseHeaders']
);

chrome.webRequest.onErrorOccurred.addListener(
  d => {
    if (/\.m3u8(?:[?#]|$)|\.mp4(?:[?#]|$)|vimeocdn\.com/i.test(d.url || '')) {
      debugLog('error', 'webRequest.error', { tabId: d.tabId, url: d.url, error: d.error, type: d.type });
    }
  },
  { urls: ['https://*.vimeo.com/*', 'https://*.vimeocdn.com/*'] }
);

function scanFrame() {
  const output = [];
  const pushed = new Set();
  const push = (obj) => {
    if (!obj?.url || pushed.has(`${obj.type || ''}:${obj.url}`)) return;
    pushed.add(`${obj.type || ''}:${obj.url}`);
    output.push(obj);
  };

  const clean = (s) => typeof s === 'string' ? s.replace(/&amp;/g, '&').replace(/\\u0026/g, '&').replace(/\\\//g, '/') : s;
  const isClearlyBrokenSubtitleUrl = (url) => {
    try {
      const u = new URL(url);
      return u.hostname === 'captions.vimeo.com' && /\/captions\/\d+\.(?:vtt|srt)$/i.test(u.pathname) && u.searchParams.has('expires') && !u.searchParams.has('sig');
    } catch (_) { return false; }
  };
  const titleFromDoc = () => {
    try { return document.title || ''; } catch (_) { return ''; }
  };

  function emitConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    const video = cfg.video || cfg.clip || {};
    const request = cfg.request || {};
    const files = request.files || cfg.files || {};
    const title = video.title || cfg.title || titleFromDoc();
    const duration = Number(video.duration || cfg.duration || 0);
    const thumbs = video.thumbs || video.thumbnails || {};
    const thumbnail = typeof thumbs === 'string' ? thumbs : (thumbs['960'] || thumbs['640'] || thumbs.base || Object.values(thumbs)[0] || '');

    const progressive = Array.isArray(files.progressive) ? files.progressive : [];
    progressive.forEach(p => {
      const url = clean(p.url);
      if (!url) return;
      push({
        type: 'mp4', url, label: 'MP4 ישיר', rank: 140,
        quality: p.quality || (p.height ? `${p.height}p` : ''),
        width: p.width, height: p.height, fps: p.fps,
        bitrate: p.bitrate, title, duration, thumbnail, source: 'playerConfig'
      });
    });

    const hls = files.hls || {};
    const hlsCdns = hls.cdns || {};
    Object.values(hlsCdns).forEach(c => {
      const url = clean(c?.url);
      if (url) push({ type: 'hls', url, label: 'זרם HLS', rank: 125, title, duration, thumbnail, source: 'playerConfig' });
    });
    if (typeof hls.url === 'string') push({ type: 'hls', url: clean(hls.url), label: 'זרם HLS', rank: 125, title, duration, thumbnail, source: 'playerConfig' });

    const dash = files.dash || {};
    const dashCdns = dash.cdns || {};
    Object.values(dashCdns).forEach(c => {
      const url = clean(c?.url);
      if (url) push({ type: 'dash', url, label: 'זרם DASH', rank: 70, title, duration, thumbnail, source: 'playerConfig' });
    });

    const textTracks = request.text_tracks || request.textTracks || cfg.text_tracks || cfg.textTracks || video.text_tracks || video.textTracks || [];
    if (Array.isArray(textTracks)) textTracks.forEach(t => {
      const url = clean(t?.url || t?.src || t?.file || '');
      if (!url) return;
      push({
        type: 'subtitle', url, label: t?.label || t?.name || t?.language || 'Subtitles', rank: 75,
        language: t?.lang || t?.language || '', subtitleKind: t?.kind || 'subtitles',
        title, duration, source: 'playerConfig'
      });
    });
  }

  const roots = [];
  for (const fn of [
    () => window.playerConfig,
    () => window.__PLAYER_CONFIG__,
    () => window.vimeo?.playerConfig,
    () => window.vimeo?.config
  ]) {
    try { const v = fn(); if (v) roots.push(v); } catch (_) {}
  }
  roots.forEach(emitConfig);

  try {
    performance.getEntriesByType('resource').forEach(e => {
      const url = clean(e.name);
      if (/\.m3u8(?:[?#]|$)/i.test(url)) push({ type: 'hls', url, label: 'זרם HLS', rank: 115, source: 'performance' });
      else if (/\.mp4(?:[?#]|$)/i.test(url) && !/[?&]range=\d+-\d+/i.test(url) && !/\/v2\/range\/prot\//i.test(url)) push({ type: 'mp4', url, label: 'MP4', rank: 100, source: 'performance' });
      else if (/\.(?:vtt|srt)(?:[?#]|$)/i.test(url) && !isClearlyBrokenSubtitleUrl(url)) push({ type: 'subtitle', url, label: 'כתוביות', rank: 60, source: 'performance' });
    });
  } catch (_) {}

  try {
    document.querySelectorAll('iframe[src],video[src],source[src]').forEach(el => {
      const url = clean(el.src);
      if (/player\.vimeo\.com\/video\/\d+/i.test(url)) push({ type: 'player', url, label: 'נגן וידאו', rank: 50, source: 'dom' });
      else if (/\.m3u8(?:[?#]|$)/i.test(url)) push({ type: 'hls', url, label: 'זרם HLS', rank: 110, source: 'dom' });
      else if (/\.mp4(?:[?#]|$)/i.test(url)) push({ type: 'mp4', url, label: 'MP4', rank: 105, source: 'dom' });
    });
  } catch (_) {}

  try {
    for (const s of document.scripts) {
      const text = s.textContent || '';
      if (!text.includes('playerConfig') && !text.includes('progressive')) continue;
      const urls = text.match(/https?:\\?\/\\?\/[^"'<>\\\s]+/g) || [];
      for (const raw of urls.slice(0, 800)) {
        const url = clean(raw);
        if (/\.m3u8(?:[?#]|$)/i.test(url)) push({ type: 'hls', url, label: 'זרם HLS', rank: 90, source: 'script' });
        else if (/\.mp4(?:[?#]|$)/i.test(url) && !/[?&]range=\d+-\d+/i.test(url)) push({ type: 'mp4', url, label: 'MP4', rank: 90, source: 'script' });
        else if (/\.(?:vtt|srt)(?:[?#]|$)/i.test(url) && !isClearlyBrokenSubtitleUrl(url)) push({ type: 'subtitle', url, label: 'כתוביות', rank: 55, source: 'script' });
      }
    }
  } catch (_) {}

  return output;
}

async function scanTab(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: scanFrame });
  let count = 0;
  for (const frame of results || []) {
    for (const item of frame.result || []) {
      await addStream(tabId, item);
      count++;
    }
  }
  return count;
}

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  await debugLog('info', 'offscreen.ensure.start');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (contexts.length) { await debugLog('info', 'offscreen.ensure.exists'); return; }
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Download and assemble media segments into a local video file.'
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
  await debugLog('info', 'offscreen.ensure.created');
}

async function getTasks() {
  const d = await chrome.storage.local.get(TASKS_KEY);
  return d[TASKS_KEY] || {};
}

async function setTask(taskId, patch) {
  const tasks = await getTasks();
  tasks[taskId] = { ...(tasks[taskId] || {}), ...patch, updatedAt: now() };
  await chrome.storage.local.set({ [TASKS_KEY]: tasks });
  if (patch.status || patch.detail) debugLog(patch.status === 'error' ? 'error' : 'info', 'task.update', { taskId, status: tasks[taskId].status, progress: tasks[taskId].progress, detail: tasks[taskId].detail, tabId: tasks[taskId].tabId ?? null, pageUrl: tasks[taskId].pageUrl || '' }).catch(() => {});
  chrome.runtime.sendMessage({ target: 'ui', type: 'taskUpdate', task: tasks[taskId] }).catch(() => {});
  return tasks[taskId];
}

async function analyzeHls(url) {
  await debugLog('info', 'hls.analyze.request', { url });
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'analyzeHls', url });
}

async function startHlsDownload(payload) {
  const job = {
    variantUrl: payload.variantUrl || '',
    audioUrl: payload.audioUrl || '',
    title: payload.title || 'וידאו',
    quality: payload.quality || '',
    split: !!payload.split,
    maxPartBytes: Math.max(0, Number(payload.maxPartBytes || 0)),
    tabId: Number.isInteger(payload.tabId) ? payload.tabId : null,
    pageUrl: payload.pageUrl || ''
  };
  await debugLog('info', 'hls.download.request', job);
  await ensureOffscreen();
  const taskId = crypto.randomUUID();
  await setTask(taskId, {
    id: taskId,
    status: 'starting',
    progress: 0,
    title: job.title,
    quality: job.quality,
    split: job.split,
    maxPartBytes: job.maxPartBytes,
    tabId: job.tabId,
    pageUrl: job.pageUrl,
    downloadIds: [],
    startedAt: now()
  });

  let ack;
  try {
    ack = await Promise.race([
      chrome.runtime.sendMessage({ ...job, taskId, target: 'offscreen', type: 'downloadHls' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Download worker did not acknowledge the job within 5 seconds.')), 5000))
    ]);
  } catch (e) {
    const error = String(e?.message || e);
    await debugLog('error', 'hls.download.dispatch.failed', { taskId, error });
    await setTask(taskId, { status: 'error', progress: 0, detail: error });
    return { ok: false, taskId, error };
  }

  if (!ack?.ok) {
    const error = ack?.error || 'Download worker rejected the job.';
    await debugLog('error', 'hls.download.dispatch.rejected', { taskId, ack });
    await setTask(taskId, { status: 'error', progress: 0, detail: error });
    return { ok: false, taskId, error };
  }

  await debugLog('info', 'hls.download.dispatch.ok', { taskId });
  return { ok: true, taskId };
}

async function cancelTask(taskId) {
  const tasks = await getTasks();
  const task = tasks[taskId];
  if (!task) return { ok: false, error: 'Download task not found.' };
  await debugLog('info', 'task.cancel.request', { taskId, status: task.status, downloadId: task.downloadId || null, downloadIds: task.downloadIds || [] });
  await setTask(taskId, { status: 'cancelling', detail: 'מבטל הורדה…', cancelRequested: true });

  try {
    await ensureOffscreen();
    await Promise.race([
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancelHls', taskId }),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, timeout: true }), 2500))
    ]);
  } catch (_) {}

  const ids = [...new Set([...(Array.isArray(task.downloadIds) ? task.downloadIds : []), task.downloadId].filter(Number.isInteger))];
  for (const id of ids) {
    try { await chrome.downloads.cancel(id); } catch (_) {}
    try { await chrome.downloads.removeFile(id); } catch (_) {}
    try { await chrome.downloads.erase({ id }); } catch (_) {}
  }
  await setTask(taskId, { status: 'cancelled', progress: task.progress || 0, detail: 'ההורדה בוטלה', cancelRequested: true });
  await debugLog('info', 'task.cancel.done', { taskId });
  return { ok: true };
}

async function cancelDirectDownload(downloadId) {
  if (!Number.isInteger(downloadId)) return { ok: false, error: 'Download ID is missing.' };
  try { await chrome.downloads.cancel(downloadId); } catch (_) {}
  try { await chrome.downloads.removeFile(downloadId); } catch (_) {}
  try { await chrome.downloads.erase({ id: downloadId }); } catch (_) {}
  await debugLog('info', 'direct.download.cancelled', { downloadId });
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(() => {
  clearTransientDiagnostics();
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { clearTransientDiagnostics(); chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); });
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.downloads.onChanged.addListener(async delta => {
  try {
    const items = await chrome.downloads.search({ id: delta.id });
    const item = items[0];
    if (!item) return;
    chrome.runtime.sendMessage({
      target: 'ui', type: 'directDownloadUpdate',
      download: { id: item.id, state: item.state, bytesReceived: item.bytesReceived || 0, totalBytes: item.totalBytes || 0, error: item.error || '' }
    }).catch(()=>{});
  } catch (_) {}
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  notifyTabContextChanged({ reason: 'activated', tabId, windowId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    clearStreamsForTab(tabId).catch(() => {});
    debugLog('info', 'tab.url.changed', { tabId, url: changeInfo.url }).catch(() => {});
    notifyTabContextChanged({ reason: 'url', tabId, windowId: tab.windowId, url: changeInfo.url });
  } else if (changeInfo.title) {
    notifyTabContextChanged({ reason: 'title', tabId, windowId: tab.windowId });
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  clearStreamsForTab(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (m?.target === 'offscreen') return false;
  (async () => {
    if (m?.type === 'getActiveTab') {
      const query = { active: true };
      if (Number.isInteger(m.windowId)) query.windowId = m.windowId;
      else query.currentWindow = true;
      const [tab] = await chrome.tabs.query(query);
      sendResponse({ ok: true, tab: tab ? { id: tab.id, windowId: tab.windowId, index: tab.index, url: tab.url || '', title: tab.title || '' } : null });
      return;
    }
    if (m?.type === 'scanTab') {
      const count = await scanTab(Number(m.tabId));
      sendResponse({ ok: true, count }); return;
    }
    if (m?.type === 'getStreams') {
      const store = await getStreamsStore();
      sendResponse({ ok: true, items: store[String(m.tabId)] || [] }); return;
    }
    if (m?.type === 'clearStreams') {
      await clearStreamsForTab(Number(m.tabId));
      sendResponse({ ok: true }); return;
    }
    if (m?.type === 'downloadDirect') {
      await debugLog('info', 'direct.download.request', { url: m.url, filename: m.filename });
      const safe = String(m.filename || 'וידאו.mp4').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
      const id = await chrome.downloads.download({ url: m.url, filename: safe.endsWith('.mp4') ? safe : `${safe}.mp4`, conflictAction: 'uniquify', saveAs: false });
      sendResponse({ ok: true, downloadId: id }); return;
    }
    if (m?.type === 'analyzeHls') {
      sendResponse(await analyzeHls(m.url)); return;
    }
    if (m?.type === 'inspectSubtitle') {
      await ensureOffscreen();
      sendResponse(await chrome.runtime.sendMessage({ target: 'offscreen', type: 'inspectSubtitle', url: m.url })); return;
    }
    if (m?.type === 'startHlsDownload') {
      sendResponse(await startHlsDownload(m)); return;
    }
    if (m?.type === 'cancelTask') {
      sendResponse(await cancelTask(String(m.taskId || ''))); return;
    }
    if (m?.type === 'cancelDirectDownload') {
      sendResponse(await cancelDirectDownload(Number(m.downloadId))); return;
    }
    if (m?.type === 'downloadSubtitle') {
      await ensureOffscreen();
      sendResponse(await chrome.runtime.sendMessage({ target: 'offscreen', type: 'downloadSubtitle', url: m.url, title: m.title || 'וידאו', label: m.label || '', language: m.language || '' })); return;
    }
    if (m?.type === 'getTasks') {
      sendResponse({ ok: true, tasks: await getTasks() }); return;
    }
    if (m?.type === 'offscreenProgress') {
      await setTask(m.taskId, { status: m.status, progress: m.progress, detail: m.detail || '', bytes: m.bytes || 0 });
      sendResponse({ ok: true }); return;
    }
    if (m?.type === 'offscreenReady') {
      const downloadId = await chrome.downloads.download({ url: m.blobUrl, filename: m.filename, conflictAction: 'uniquify', saveAs: false });
      const tasks = await getTasks();
      const current = tasks[m.taskId] || {};
      const downloadIds = [...new Set([...(Array.isArray(current.downloadIds) ? current.downloadIds : []), downloadId])];
      const saveProgress = Number.isFinite(Number(m.progress)) ? Math.max(0, Math.min(100, Number(m.progress))) : 100;
      await setTask(m.taskId, { status: 'saving', progress: saveProgress, downloadId, downloadIds, detail: m.detail || 'Chrome שומר את הקובץ' });
      sendResponse({ ok: true, downloadId }); return;
    }
    if (m?.type === 'offscreenReadySubtitle') {
      const downloadId = await chrome.downloads.download({ url: m.blobUrl, filename: m.filename, conflictAction: 'uniquify', saveAs: false });
      sendResponse({ ok: true, downloadId }); return;
    }
    if (m?.type === 'offscreenDone') {
      const tasks = await getTasks();
      if (tasks[m.taskId]?.cancelRequested || ['cancelled','cancelling'].includes(tasks[m.taskId]?.status)) {
        sendResponse({ ok: true, ignored: 'cancelled' }); return;
      }
      await setTask(m.taskId, { status: m.ok ? 'done' : 'error', progress: m.ok ? 100 : (m.progress || 0), detail: m.error || m.detail || '' });
      sendResponse({ ok: true }); return;
    }
    if (m?.type === 'debugLog') {
      await debugLog(m.level || 'info', m.event || 'offscreen', m.data || {});
      sendResponse({ ok: true }); return;
    }
    if (m?.type === 'getDebugBundle') {
      const [dbg, tasks, streams] = await Promise.all([
        chrome.storage.local.get(DEBUG_KEY),
        getTasks(),
        getStreamsStore()
      ]);
      sendResponse({
        ok: true,
        manifest: { version: chrome.runtime.getManifest().version },
        logs: dbg[DEBUG_KEY] || [],
        tasks,
        streams: redactData(streams[String(m.tabId)] || [])
      });
      return;
    }
    sendResponse({ ok: false, error: 'Unknown message' });
  })().catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
