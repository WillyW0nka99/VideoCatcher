const PLAYLIST_TIMEOUT_MS = 15000;
const SEGMENT_TIMEOUT_MS = 25000;
const RETRIES = 3;
const activeJobs = new Map();

function abs(base, value) { return new URL(value, base).href; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function attrList(line) {
  const out = {};
  const s = line.slice(line.indexOf(':') + 1);
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m;
  while ((m = re.exec(s))) out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
  return out;
}

async function debug(level, event, data = {}) {
  try { await chrome.runtime.sendMessage({ type: 'debugLog', level, event, data }); } catch (_) {}
}

async function fetchWithTimeout(url, options = {}, timeoutMs, label, taskId = '') {
  const controller = new AbortController();
  const job = taskId ? activeJobs.get(taskId) : null;
  if (job?.cancelled) throw new Error('ההורדה בוטלה.');
  if (job) job.controllers.add(controller);
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const started = performance.now();
  try {
    const r = await fetch(url, {
      ...options,
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal
    });
    if (job?.cancelled) throw new Error('ההורדה בוטלה.');
    if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status} ${r.statusText || ''}`.trim());
    return r;
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    const cancelled = job?.cancelled || String(e?.message || e).toLowerCase().includes('cancel');
    if (cancelled) throw new Error('ההורדה בוטלה.');
    const isTimeout = e?.name === 'AbortError' || String(e).toLowerCase().includes('timeout');
    const msg = isTimeout ? `${label} timed out after ${Math.round(timeoutMs/1000)}s` : `${label} failed: ${e?.message || e}`;
    await debug('error', 'fetch.failed', { taskId: taskId || null, label, url, timeoutMs, elapsedMs: ms, error: String(e?.message || e), timeout: isTimeout });
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
    if (job) job.controllers.delete(controller);
  }
}

async function fetchText(url, taskId = '') {
  await debug('info', 'playlist.fetch.start', { taskId: taskId || null, url, timeoutMs: PLAYLIST_TIMEOUT_MS });
  const r = await fetchWithTimeout(url, { headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/vtt, text/plain, */*' } }, PLAYLIST_TIMEOUT_MS, 'Playlist request', taskId);
  const text = await r.text();
  await debug('info', 'playlist.fetch.ok', { taskId: taskId || null, url, status: r.status, bytes: text.length, contentType: r.headers.get('content-type') || '' });
  return text;
}

async function fetchBytes(url, range, taskId = '') {
  const headers = {};
  if (range) headers.Range = `bytes=${range.start}-${range.end}`;
  const r = await fetchWithTimeout(url, { headers }, SEGMENT_TIMEOUT_MS, 'Media segment', taskId);
  return new Uint8Array(await r.arrayBuffer());
}

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const audioGroups = new Map();
  const subtitleGroups = new Map();
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrList(line);
      if (a.URI && a.TYPE === 'AUDIO') {
        const arr = audioGroups.get(a['GROUP-ID']) || [];
        arr.push({ url: abs(baseUrl, a.URI), name: a.NAME || 'audio', language: a.LANGUAGE || '', isDefault: a.DEFAULT === 'YES' });
        audioGroups.set(a['GROUP-ID'], arr);
      }
      if (a.URI && a.TYPE === 'SUBTITLES') {
        const arr = subtitleGroups.get(a['GROUP-ID']) || [];
        arr.push({ url: abs(baseUrl, a.URI), label: a.NAME || a.LANGUAGE || 'Subtitles', language: a.LANGUAGE || '', isDefault: a.DEFAULT === 'YES', forced: a.FORCED === 'YES' });
        subtitleGroups.set(a['GROUP-ID'], arr);
      }
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrList(line);
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j >= lines.length) continue;
      const res = (a.RESOLUTION || '').match(/(\d+)x(\d+)/);
      variants.push({
        url: abs(baseUrl, lines[j]), bandwidth: Number(a.BANDWIDTH || 0),
        width: res ? Number(res[1]) : 0, height: res ? Number(res[2]) : 0,
        codecs: a.CODECS || '', audioGroup: a.AUDIO || '', subtitleGroup: a.SUBTITLES || ''
      });
      i = j;
    }
  }
  variants.forEach(v => {
    const group = audioGroups.get(v.audioGroup) || [];
    v.audio = group.find(x => x.isDefault) || group[0] || null;
    v.subtitles = subtitleGroups.get(v.subtitleGroup) || [];
    v.quality = v.height ? `${v.height}p` : (v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : 'Auto');
  });
  const subtitleMap = new Map();
  for (const group of subtitleGroups.values()) for (const sub of group) subtitleMap.set(`${sub.language}|${sub.url}`, sub);
  return { variants: variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth)), subtitles: [...subtitleMap.values()] };
}

function parseMedia(text, baseUrl) {
  if (/#EXT-X-KEY:(?![^\n]*METHOD=NONE)/i.test(text)) throw new Error('זרם HLS מוצפן אינו נתמך.');
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  let init = null;
  let pendingRange = null;
  let lastRangeEnd = -1;
  const segments = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrList(line);
      if (a.URI) {
        let range = null;
        if (a.BYTERANGE) {
          const [lenS, offS] = a.BYTERANGE.split('@');
          const len = Number(lenS), start = offS != null ? Number(offS) : 0;
          range = { start, end: start + len - 1 };
        }
        init = { url: abs(baseUrl, a.URI), range };
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const spec = line.slice(line.indexOf(':') + 1);
      const [lenS, offS] = spec.split('@');
      const len = Number(lenS);
      const start = offS != null ? Number(offS) : lastRangeEnd + 1;
      pendingRange = { start, end: start + len - 1 };
      lastRangeEnd = pendingRange.end;
    } else if (!line.startsWith('#')) {
      segments.push({ url: abs(baseUrl, line), range: pendingRange });
      pendingRange = null;
    }
  }
  return { init, segments };
}

function u32(a, o) { return ((a[o] << 24) | (a[o+1] << 16) | (a[o+2] << 8) | a[o+3]) >>> 0; }
function w32(a, o, v) { a[o] = (v >>> 24) & 255; a[o+1] = (v >>> 16) & 255; a[o+2] = (v >>> 8) & 255; a[o+3] = v & 255; }
function typeAt(a, o) { return String.fromCharCode(a[o], a[o+1], a[o+2], a[o+3]); }
function boxes(a, start = 0, end = a.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(a, p);
    const type = typeAt(a, p + 4);
    let header = 8;
    if (size === 1) throw new Error('מבנה ה-MP4 גדול מדי לעיבוד בדפדפן.');
    if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type, start: p, end: p + size, size, header });
    p += size;
  }
  return out;
}
function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrays) { out.set(a, p); p += a.length; }
  return out;
}
function makeBox(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  w32(out, 0, out.length);
  for (let i = 0; i < 4; i++) out[4+i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}
function childCopies(boxBytes) { return boxes(boxBytes, 8).map(b => ({ type: b.type, bytes: boxBytes.slice(b.start, b.end) })); }
function patchTkhd(trak, trackId) {
  const out = trak.slice(); const kids = boxes(out, 8); const tkhd = kids.find(x => x.type === 'tkhd');
  if (!tkhd) return out; const version = out[tkhd.start + 8]; const offset = tkhd.start + (version === 1 ? 28 : 20); w32(out, offset, trackId); return out;
}
function patchTrex(trex, trackId) { const out = trex.slice(); if (out.length >= 16) w32(out, 12, trackId); return out; }
function patchMvhd(mvhd, nextTrackId) { const out = mvhd.slice(); const version = out[8]; const offset = version === 1 ? 116 : 104; if (out.length >= offset + 4) w32(out, offset, nextTrackId); return out; }
function mergeInit(videoInit, audioInit) {
  const vt = boxes(videoInit), at = boxes(audioInit);
  const ftyp = vt.find(x => x.type === 'ftyp'), vmoov = vt.find(x => x.type === 'moov'), amoov = at.find(x => x.type === 'moov');
  if (!ftyp || !vmoov || !amoov) throw new Error('מבנה הווידאו אינו נתמך לעיבוד בדפדפן.');
  const vkids = childCopies(videoInit.slice(vmoov.start, vmoov.end));
  const akids = childCopies(audioInit.slice(amoov.start, amoov.end));
  const atrack = akids.find(x => x.type === 'trak'), amvex = akids.find(x => x.type === 'mvex');
  if (!atrack) throw new Error('חסר מידע על ערוץ האודיו.');
  const patchedAudioTrak = patchTkhd(atrack.bytes, 2);
  const audioTrex = amvex ? childCopies(amvex.bytes).find(x => x.type === 'trex') : null;
  const outKids = []; let insertedTrack = false;
  for (const k of vkids) {
    if (k.type === 'mvhd') outKids.push(patchMvhd(k.bytes, 3));
    else if (k.type === 'mvex') {
      if (!insertedTrack) { outKids.push(patchedAudioTrak); insertedTrack = true; }
      const mkids = childCopies(k.bytes).map(x => x.bytes); if (audioTrex) mkids.push(patchTrex(audioTrex.bytes, 2)); outKids.push(makeBox('mvex', concat(mkids)));
    } else outKids.push(k.bytes);
  }
  if (!insertedTrack) outKids.push(patchedAudioTrak);
  return concat([videoInit.slice(ftyp.start, ftyp.end), makeBox('moov', concat(outKids))]);
}
function patchFragment(input, trackId, sequence) {
  const out = input.slice();
  for (const top of boxes(out)) {
    if (top.type !== 'moof') continue;
    for (const child of boxes(out, top.start + 8, top.end)) {
      if (child.type === 'mfhd' && child.size >= 16) w32(out, child.start + 12, sequence);
      if (child.type !== 'traf') continue;
      for (const sub of boxes(out, child.start + 8, child.end)) if (sub.type === 'tfhd' && sub.size >= 16) w32(out, sub.start + 12, trackId);
    }
  }
  return out;
}

async function parallelDownload(items, onProgress, concurrency = 3, phase = 'media', taskId = '') {
  const out = new Array(items.length);
  let next = 0, done = 0, bytes = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      let lastErr;
      for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
          const b = await fetchBytes(items[i].url, items[i].range, taskId);
          out[i] = b; bytes += b.length; done++;
          onProgress(done, items.length, bytes);
          lastErr = null; break;
        } catch (e) {
          lastErr = e;
          await debug('warn', 'segment.retry', { phase, index: i + 1, total: items.length, attempt, maxAttempts: RETRIES, url: items[i].url, range: items[i].range || null, error: e.message });
          if (attempt < RETRIES) await sleep(600 * (2 ** (attempt - 1)));
        }
      }
      if (lastErr) throw new Error(`${phase} segment ${i + 1}/${items.length} failed after ${RETRIES} attempts: ${lastErr.message}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
  return { chunks: out, bytes };
}

function sanitizeFilename(name, ext) {
  const base = String(name || 'Video').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 170) || 'Video';
  return `${base}.${ext}`;
}
async function progress(taskId, status, progressValue, detail, bytes = 0) {
  await chrome.runtime.sendMessage({ type: 'offscreenProgress', taskId, status, progress: Math.max(0, Math.min(100, progressValue)), detail, bytes });
}

async function analyzeHls(url) {
  try {
    const text = await fetchText(url);
    if (!text.includes('#EXTM3U')) throw new Error('This is not an HLS playlist.');
    const parsed = parseMaster(text, url);
    await debug('info', 'hls.analyze.ok', { url, variantCount: parsed.variants.length, subtitleCount: parsed.subtitles.length });
    if (!parsed.variants.length) return { ok: true, variants: [{ url, quality: 'Original', height: 0, width: 0, bandwidth: 0, audio: null, subtitles: [] }], subtitles: parsed.subtitles };
    return { ok: true, variants: parsed.variants, subtitles: parsed.subtitles };
  } catch (e) {
    await debug('error', 'hls.analyze.failed', { url, error: e.message });
    return { ok: false, error: e.message };
  }
}

async function downloadHls(m) {
  const { taskId, variantUrl, audioUrl, title, quality } = m;
  const job = { cancelled: false, controllers: new Set() };
  activeJobs.set(taskId, job);
  try {
    await debug('info', 'hls.download.start', { taskId, variantUrl, audioUrl, quality });
    await progress(taskId, 'preparing', 2, 'פותח את רשימות המדיה…');

    const [videoText, audioText] = await Promise.all([
      fetchText(variantUrl, taskId),
      audioUrl ? fetchText(audioUrl, taskId) : Promise.resolve(null)
    ]);
    const video = parseMedia(videoText, variantUrl);
    if (!video.segments.length) throw new Error('לא נמצאו מקטעי וידאו.');
    let audio = audioText ? parseMedia(audioText, audioUrl) : null;
    if (audio && !audio.segments.length) audio = null;
    await debug('info', 'hls.media.parsed', { taskId, videoSegments: video.segments.length, audioSegments: audio?.segments.length || 0, videoInit: !!video.init, audioInit: !!audio?.init });

    const totalSegs = video.segments.length + (audio?.segments.length || 0) + (video.init ? 1 : 0) + (audio?.init ? 1 : 0);
    await progress(taskId, 'preparing', 5, `נמצאו ${totalSegs} חלקי מדיה`);

    let videoInit = null, audioInit = null;
    [videoInit, audioInit] = await Promise.all([
      video.init ? fetchBytes(video.init.url, video.init.range, taskId) : Promise.resolve(null),
      audio?.init ? fetchBytes(audio.init.url, audio.init.range, taskId) : Promise.resolve(null)
    ]);
    let initBytes = (videoInit?.length || 0) + (audioInit?.length || 0);

    let vDone = 0, aDone = 0, vBytes = 0, aBytes = 0;
    const updateCombined = () => {
      const total = video.segments.length + (audio?.segments.length || 0);
      const done = vDone + aDone;
      const pct = 8 + (total ? 78 * (done / total) : 78);
      const detail = audio
        ? `וידאו ${vDone}/${video.segments.length} • אודיו ${aDone}/${audio.segments.length}`
        : `וידאו ${vDone}/${video.segments.length}`;
      progress(taskId, 'downloading', pct, detail, initBytes + vBytes + aBytes).catch(()=>{});
    };
    await progress(taskId, 'downloading', 8, audio ? 'מוריד וידאו ואודיו במקביל…' : 'מוריד וידאו…', initBytes);

    const [vd, ad] = await Promise.all([
      parallelDownload(video.segments, (d,t,b) => { vDone=d; vBytes=b; updateCombined(); }, 3, 'video', taskId),
      audio ? parallelDownload(audio.segments, (d,t,b) => { aDone=d; aBytes=b; updateCombined(); }, 3, 'audio', taskId) : Promise.resolve(null)
    ]);
    if (job.cancelled) throw new Error('ההורדה בוטלה.');
    const bytes = initBytes + vd.bytes + (ad?.bytes || 0);

    await progress(taskId, 'assembling', 90, audio ? 'מחבר וידאו ואודיו…' : 'מחבר את מקטעי הווידאו…', bytes);
    let finalBytes, ext;
    if (videoInit) {
      if (audio && audioInit) {
        const init = mergeInit(videoInit, audioInit);
        const parts = [init]; let seq = 1; const n = Math.max(vd.chunks.length, ad.chunks.length);
        for (let i = 0; i < n; i++) { if (vd.chunks[i]) parts.push(patchFragment(vd.chunks[i], 1, seq++)); if (ad.chunks[i]) parts.push(patchFragment(ad.chunks[i], 2, seq++)); }
        finalBytes = concat(parts);
      } else {
        const parts = [videoInit]; let seq = 1; for (const seg of vd.chunks) parts.push(patchFragment(seg, 1, seq++)); finalBytes = concat(parts);
      }
      ext = 'mp4';
    } else {
      if (audio) throw new Error('מבנה הזרם הזה אינו נתמך למיזוג ישיר בדפדפן.');
      finalBytes = concat(vd.chunks); ext = 'ts';
    }
    if (job.cancelled) throw new Error('ההורדה בוטלה.');

    await progress(taskId, 'assembling', 96, `יוצר קובץ ${quality || ''}…`, finalBytes.length);
    await debug('info', 'hls.assemble.ok', { taskId, bytes: finalBytes.length, ext });
    const blob = new Blob([finalBytes], { type: ext === 'mp4' ? 'video/mp4' : 'video/mp2t' });
    const blobUrl = URL.createObjectURL(blob);
    job.blobUrl = blobUrl;
    const filename = sanitizeFilename(`${title || 'וידאו'}${quality ? ` - ${quality}` : ''}`, ext);
    const r = await chrome.runtime.sendMessage({ type: 'offscreenReady', taskId, blobUrl, filename });
    if (!r?.ok) throw new Error(r?.error || 'לא ניתן להתחיל את שמירת הקובץ בדפדפן.');
    setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
    await chrome.runtime.sendMessage({ type: 'offscreenDone', taskId, ok: true, detail: 'ההורדה הועברה ל-Chrome' });
  } catch (e) {
    const cancelled = job.cancelled || String(e?.message || e).toLowerCase().includes('cancel');
    await debug(cancelled ? 'info' : 'error', cancelled ? 'hls.download.cancelled' : 'hls.download.failed', { taskId, variantUrl, audioUrl, error: String(e?.message || e), stack: String(e?.stack || '') });
    if (!cancelled) await chrome.runtime.sendMessage({ type: 'offscreenDone', taskId, ok: false, error: String(e?.message || e) });
  } finally {
    const j = activeJobs.get(taskId);
    if (j?.blobUrl && j.cancelled) try { URL.revokeObjectURL(j.blobUrl); } catch (_) {}
    activeJobs.delete(taskId);
  }
}

function cancelHls(taskId) {
  const job = activeJobs.get(taskId);
  if (!job) return { ok: true, alreadyStopped: true };
  job.cancelled = true;
  for (const controller of job.controllers) try { controller.abort('cancelled'); } catch (_) {}
  job.controllers.clear();
  if (job.blobUrl) try { URL.revokeObjectURL(job.blobUrl); } catch (_) {}
  debug('info', 'hls.cancel.received', { taskId }).catch(()=>{});
  return { ok: true };
}

function stripVttHeader(text, first) {
  let t = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (first) return t.trimEnd();
  t = t.replace(/^WEBVTT[^\n]*\n+/i, '');
  return t.trim();
}

function parseSubtitlePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  return lines.filter(x => !x.startsWith('#')).map(x => abs(baseUrl, x));
}


function subtitleTextSample(text) {
  return String(text || '')
    .replace(/^WEBVTT[^\n]*$/gmi, ' ')
    .replace(/^NOTE[^\n]*(?:\n(?!\n).*)*/gmi, ' ')
    .replace(/^\d+$/gm, ' ')
    .replace(/^\s*\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->.*$/gm, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&lrm;|&rlm;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectSubtitleLanguage(text) {
  const sample = subtitleTextSample(text).slice(0, 60000);
  const hebrew = (sample.match(/[\u0590-\u05FF]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  const arabic = (sample.match(/[\u0600-\u06FF]/g) || []).length;
  const letters = hebrew + latin + arabic;
  if (!letters) return { code: '', label: '', confidence: 0, counts: { hebrew, latin, arabic } };
  const ranked = [
    { code: 'he', label: 'עברית', count: hebrew },
    { code: 'en', label: 'אנגלית', count: latin },
    { code: 'ar', label: 'ערבית', count: arabic }
  ].sort((a,b)=>b.count-a.count);
  const best = ranked[0];
  return { code: best.count ? best.code : '', label: best.count ? best.label : '', confidence: best.count / letters, counts: { hebrew, latin, arabic } };
}

async function inspectSubtitle(m) {
  try {
    await debug('info', 'subtitle.inspect.start', { url: m.url });
    let text = await fetchText(m.url);
    if (text.includes('#EXTM3U')) {
      const urls = parseSubtitlePlaylist(text, m.url).slice(0, 3);
      if (!urls.length) throw new Error('לא נמצאו מקטעי כתוביות.');
      const chunks = await Promise.all(urls.map(u => fetchText(u)));
      text = chunks.join('\n');
    }
    const detected = detectSubtitleLanguage(text);
    await debug('info', 'subtitle.inspect.ok', { url: m.url, detected });
    return { ok: true, ...detected };
  } catch (e) {
    await debug('error', 'subtitle.inspect.failed', { url: m.url, error: String(e?.message || e) });
    return { ok: false, error: String(e?.message || e) };
  }
}

async function downloadSubtitle(m) {
  try {
    await debug('info', 'subtitle.download.start', { url: m.url, language: m.language, label: m.label });
    const text = await fetchText(m.url);
    let output = text;
    let ext = /\.srt(?:[?#]|$)/i.test(m.url) ? 'srt' : 'vtt';
    if (text.includes('#EXTM3U')) {
      const urls = parseSubtitlePlaylist(text, m.url);
      if (!urls.length) throw new Error('לא נמצאו מקטעי כתוביות.');
      const chunks = new Array(urls.length);
      let next = 0;
      async function worker() {
        while (true) {
          const i = next++;
          if (i >= urls.length) return;
          chunks[i] = await fetchText(urls[i]);
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
      output = chunks.map((x,i)=>stripVttHeader(x, i===0)).join('\n\n');
      if (!/^WEBVTT/i.test(output)) output = `WEBVTT\n\n${output}`;
      ext = 'vtt';
    }
    const blob = new Blob([output], { type: ext === 'vtt' ? 'text/vtt;charset=utf-8' : 'application/x-subrip;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const suffix = [m.language, m.label].filter(Boolean).join(' - ') || 'כתוביות';
    const filename = sanitizeFilename(`${m.title || 'וידאו'} - ${suffix}`, ext);
    const r = await chrome.runtime.sendMessage({ type: 'offscreenReadySubtitle', blobUrl, filename });
    if (!r?.ok) throw new Error(r?.error || 'לא ניתן להתחיל את הורדת הכתוביות.');
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    await debug('info', 'subtitle.download.ok', { filename, bytes: blob.size });
    return { ok: true, downloadId: r.downloadId };
  } catch (e) {
    await debug('error', 'subtitle.download.failed', { url: m.url, error: String(e?.message || e) });
    return { ok: false, error: String(e?.message || e) };
  }
}

chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (m?.target !== 'offscreen') return;
  (async () => {
    if (m.type === 'analyzeHls') { sendResponse(await analyzeHls(m.url)); return; }
    if (m.type === 'downloadHls') {
      await debug('info', 'offscreen.download.received', { taskId: m.taskId, quality: m.quality, hasVideoUrl: !!m.variantUrl, hasAudioUrl: !!m.audioUrl });
      downloadHls(m);
      sendResponse({ ok: true });
      return;
    }
    if (m.type === 'cancelHls') { sendResponse(cancelHls(String(m.taskId || ''))); return; }
    if (m.type === 'inspectSubtitle') { sendResponse(await inspectSubtitle(m)); return; }
    if (m.type === 'downloadSubtitle') { sendResponse(await downloadSubtitle(m)); return; }
    sendResponse({ ok: false, error: 'בקשת רקע לא מוכרת' });
  })().catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
