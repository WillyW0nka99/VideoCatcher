const PLAYLIST_TIMEOUT_MS = 15000;
const SEGMENT_TIMEOUT_MS = 25000;
const RETRIES = 3;
const DEFAULT_SPLIT_BYTES = 195000000;
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
  let pendingDuration = 0;
  const segments = [];
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const value = Number.parseFloat(line.slice(line.indexOf(':') + 1));
      pendingDuration = Number.isFinite(value) && value > 0 ? value : 0;
    } else if (line.startsWith('#EXT-X-MAP:')) {
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
      segments.push({ url: abs(baseUrl, line), range: pendingRange, duration: pendingDuration });
      pendingRange = null;
      pendingDuration = 0;
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
function u64(a, o) { return (BigInt(u32(a, o)) << 32n) | BigInt(u32(a, o + 4)); }
function w64(a, o, v) { const n=BigInt(v); w32(a,o,Number((n>>32n)&0xffffffffn)); w32(a,o+4,Number(n&0xffffffffn)); }
function writeDurationTicks(out, offset, version, seconds, timescale) {
  const ticks = BigInt(Math.max(0, Math.round(Number(seconds || 0) * Number(timescale || 0))));
  if (version === 1) w64(out, offset, ticks);
  else w32(out, offset, Number(ticks > 0xffffffffn ? 0xffffffffn : ticks));
}
function patchInitDuration(init, seconds) {
  const duration = Number(seconds || 0);
  if (!(duration > 0)) return init;
  const out = init.slice();
  const moov = boxes(out).find(x => x.type === 'moov');
  if (!moov) return out;
  const kids = boxes(out, moov.start + 8, moov.end);
  const mvhd = kids.find(x => x.type === 'mvhd');
  let movieTimescale = 0;
  if (mvhd) {
    const version = out[mvhd.start + 8];
    const timescaleOffset = mvhd.start + (version === 1 ? 28 : 20);
    const durationOffset = mvhd.start + (version === 1 ? 32 : 24);
    movieTimescale = u32(out, timescaleOffset);
    if (movieTimescale) writeDurationTicks(out, durationOffset, version, duration, movieTimescale);
  }
  for (const trak of kids.filter(x => x.type === 'trak')) {
    const tkids = boxes(out, trak.start + 8, trak.end);
    const tkhd = tkids.find(x => x.type === 'tkhd');
    if (tkhd && movieTimescale) {
      const version = out[tkhd.start + 8];
      const durationOffset = tkhd.start + (version === 1 ? 36 : 28);
      writeDurationTicks(out, durationOffset, version, duration, movieTimescale);
    }
    const mdia = tkids.find(x => x.type === 'mdia');
    if (mdia) {
      const mdhd = boxes(out, mdia.start + 8, mdia.end).find(x => x.type === 'mdhd');
      if (mdhd) {
        const version = out[mdhd.start + 8];
        const timescaleOffset = mdhd.start + (version === 1 ? 28 : 20);
        const durationOffset = mdhd.start + (version === 1 ? 32 : 24);
        const timescale = u32(out, timescaleOffset);
        if (timescale) writeDurationTicks(out, durationOffset, version, duration, timescale);
      }
    }
  }
  const mvex = kids.find(x => x.type === 'mvex');
  if (mvex && movieTimescale) {
    const mehd = boxes(out, mvex.start + 8, mvex.end).find(x => x.type === 'mehd');
    if (mehd) {
      const version = out[mehd.start + 8];
      writeDurationTicks(out, mehd.start + 12, version, duration, movieTimescale);
    }
  }
  return out;
}
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
function fragmentTfdt(input) {
  for (const top of boxes(input)) {
    if (top.type !== 'moof') continue;
    for (const child of boxes(input, top.start + 8, top.end)) {
      if (child.type !== 'traf') continue;
      for (const sub of boxes(input, child.start + 8, child.end)) {
        if (sub.type !== 'tfdt' || sub.size < 16) continue;
        const version=input[sub.start+8];
        return version===1 ? u64(input,sub.start+12) : BigInt(u32(input,sub.start+12));
      }
    }
  }
  return null;
}
function patchFragment(input, trackId, sequence, timeOffset = null) {
  const out = input.slice();
  for (const top of boxes(out)) {
    if (top.type !== 'moof') continue;
    for (const child of boxes(out, top.start + 8, top.end)) {
      if (child.type === 'mfhd' && child.size >= 16) w32(out, child.start + 12, sequence);
      if (child.type !== 'traf') continue;
      for (const sub of boxes(out, child.start + 8, child.end)) {
        if (sub.type === 'tfhd' && sub.size >= 16) w32(out, sub.start + 12, trackId);
        if (sub.type === 'tfdt' && sub.size >= 16 && timeOffset != null) {
          const version=out[sub.start+8];
          const current=version===1 ? u64(out,sub.start+12) : BigInt(u32(out,sub.start+12));
          const shifted=current>=timeOffset ? current-timeOffset : 0n;
          if (version===1) w64(out,sub.start+12,shifted); else w32(out,sub.start+12,Number(shifted & 0xffffffffn));
        }
      }
    }
  }
  return out;
}

function splitIndexGroups(videoChunks, audioChunks, initSize, maxBytes) {
  const limit=Math.max(1000000,Number(maxBytes)||DEFAULT_SPLIT_BYTES);
  const n=Math.max(videoChunks.length,audioChunks?.length||0);
  const groups=[]; let current=[]; let bytes=initSize;
  for(let i=0;i<n;i++){
    const add=(videoChunks[i]?.length||0)+(audioChunks?.[i]?.length||0);
    if(current.length && bytes+add>limit){groups.push(current);current=[];bytes=initSize;}
    if(initSize+add>limit && !current.length) throw new Error('מקטע מדיה בודד גדול מדי לפיצול בגבול שנבחר.');
    current.push(i);bytes+=add;
  }
  if(current.length)groups.push(current);
  return groups;
}
function buildMp4Part(init, videoChunks, audioChunks, indices, durationSeconds = 0) {
  const parts=[durationSeconds > 0 ? patchInitDuration(init, durationSeconds) : init]; let seq=1;
  const firstV=indices.map(i=>videoChunks[i]).find(Boolean);
  const firstA=audioChunks ? indices.map(i=>audioChunks[i]).find(Boolean) : null;
  const vBase=firstV?fragmentTfdt(firstV):null;
  const aBase=firstA?fragmentTfdt(firstA):null;
  for(const i of indices){
    if(videoChunks[i])parts.push(patchFragment(videoChunks[i],1,seq++,vBase));
    if(audioChunks?.[i])parts.push(patchFragment(audioChunks[i],2,seq++,aBase));
  }
  return concat(parts);
}
function buildTsParts(chunks,maxBytes){
  const limit=Math.max(1000000,Number(maxBytes)||DEFAULT_SPLIT_BYTES);
  const groups=[];let cur=[];let size=0;
  for(const chunk of chunks){
    if(cur.length&&size+chunk.length>limit){groups.push(cur);cur=[];size=0;}
    if(chunk.length>limit)throw new Error('מקטע מדיה בודד גדול מדי לפיצול בגבול שנבחר.');
    cur.push(chunk);size+=chunk.length;
  }
  if(cur.length)groups.push(cur);
  return groups.map(concat);
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
  const split=!!m.split;
  const maxPartBytes=split?Math.max(1000000,Number(m.maxPartBytes)||DEFAULT_SPLIT_BYTES):0;
  const job = { cancelled: false, controllers: new Set(), blobUrls: new Set() };
  activeJobs.set(taskId, job);
  try {
    await debug('info', 'hls.download.start', { taskId, variantUrl, audioUrl, quality, split, maxPartBytes });
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

    await progress(taskId, 'assembling', 90, split ? 'מחלק את הסרטון לקבצים…' : (audio ? 'מחבר וידאו ואודיו…' : 'מחבר את מקטעי הווידאו…'), bytes);

    let outputs=[]; let ext;
    if (videoInit) {
      const init = audio && audioInit ? mergeInit(videoInit, audioInit) : videoInit;
      ext='mp4';
      if(split){
        const groups=splitIndexGroups(vd.chunks,ad?.chunks||null,init.length,maxPartBytes);
        outputs=groups.map(indices=>{
          const partDuration=indices.reduce((sum,i)=>sum+Number(video.segments[i]?.duration||0),0);
          return buildMp4Part(init,vd.chunks,ad?.chunks||null,indices,partDuration);
        });
      }else{
        const indices=Array.from({length:Math.max(vd.chunks.length,ad?.chunks.length||0)},(_,i)=>i);
        outputs=[buildMp4Part(init,vd.chunks,ad?.chunks||null,indices)];
      }
    } else {
      if (audio) throw new Error('מבנה הזרם הזה אינו נתמך למיזוג ישיר בדפדפן.');
      ext='ts';
      outputs=split?buildTsParts(vd.chunks,maxPartBytes):[concat(vd.chunks)];
    }
    if (job.cancelled) throw new Error('ההורדה בוטלה.');

    const totalParts=outputs.length;
    const totalOutputBytes=outputs.reduce((n,x)=>n+x.length,0);
    await debug('info', 'hls.assemble.ok', { taskId, bytes: totalOutputBytes, ext, split, partCount: totalParts, partBytes: outputs.map(x=>x.length) });

    for(let i=0;i<outputs.length;i++){
      if(job.cancelled)throw new Error('ההורדה בוטלה.');
      const out=outputs[i];
      const num=String(i+1).padStart(2,'0'), total=String(totalParts).padStart(2,'0');
      const suffix=split&&totalParts>1?` - part-${num}-of-${total}`:'';
      const filename=sanitizeFilename(`${title || 'וידאו'}${quality ? ` - ${quality}` : ''}${suffix}`,ext);
      const savePct=96+Math.round(3*((i+1)/Math.max(1,totalParts)));
      await progress(taskId,'assembling',savePct,split?`יוצר חלק ${i+1} מתוך ${totalParts}…`:`יוצר קובץ ${quality || ''}…`,out.length);
      const blob=new Blob([out],{type:ext==='mp4'?'video/mp4':'video/mp2t'});
      const blobUrl=URL.createObjectURL(blob);
      job.blobUrls.add(blobUrl);
      const r=await chrome.runtime.sendMessage({type:'offscreenReady',taskId,blobUrl,filename,progress:savePct,detail:split?`שומר חלק ${i+1} מתוך ${totalParts}`:'Chrome שומר את הקובץ'});
      if(!r?.ok)throw new Error(r?.error||'לא ניתן להתחיל את שמירת הקובץ בדפדפן.');
      setTimeout(()=>{try{URL.revokeObjectURL(blobUrl)}catch(_){} job.blobUrls.delete(blobUrl);},120000);
      outputs[i]=null;
    }
    await chrome.runtime.sendMessage({ type: 'offscreenDone', taskId, ok: true, detail: split&&totalParts>1 ? `נשמרו ${totalParts} חלקים` : 'ההורדה הועברה ל-Chrome' });
  } catch (e) {
    const cancelled = job.cancelled || String(e?.message || e).toLowerCase().includes('cancel');
    await debug(cancelled ? 'info' : 'error', cancelled ? 'hls.download.cancelled' : 'hls.download.failed', { taskId, variantUrl, audioUrl, error: String(e?.message || e), stack: String(e?.stack || '') });
    if (!cancelled) await chrome.runtime.sendMessage({ type: 'offscreenDone', taskId, ok: false, error: String(e?.message || e) });
  } finally {
    const j = activeJobs.get(taskId);
    if (j?.cancelled) for (const url of j.blobUrls || []) try { URL.revokeObjectURL(url); } catch (_) {}
    activeJobs.delete(taskId);
  }
}

function cancelHls(taskId) {
  const job = activeJobs.get(taskId);
  if (!job) return { ok: true, alreadyStopped: true };
  job.cancelled = true;
  for (const controller of job.controllers) try { controller.abort('cancelled'); } catch (_) {}
  job.controllers.clear();
  for (const url of job.blobUrls || []) try { URL.revokeObjectURL(url); } catch (_) {}
  job.blobUrls?.clear();
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
