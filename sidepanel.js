const $ = id => document.getElementById(id);
let activeTab = null;
let allItems = [];
let choices = [];
let subtitles = [];
let currentTaskId = null;
let currentDirectDownloadId = null;
let lastTaskUpdateAt = 0;
let currentTaskStatus = '';
const MAX_SPLIT_BYTES = 195000000;

function fmtDuration(sec){ if(!sec)return ''; sec=Math.round(sec); const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60; return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`; }
function fmtSize(bytes){ if(!bytes)return ''; const mb=bytes/1e6; return mb>=1000?`${(mb/1000).toFixed(1)} GB`:`${Math.round(mb)} MB`; }
function estimateSize(choice){ const duration=Number(choice?.item?.duration||0); const bitrate=Number(choice?.bitrate||0); return duration&&bitrate ? duration*bitrate/8 : 0; }
function titleFor(item){ return item.title || activeTab?.title?.replace(/\s*[|•-]\s*עזריאלי.*$/i,'') || 'וידאו'; }
function setStatus(title,text){ $('statusTitle').textContent=title; $('statusText').textContent=text; }
function setProgress(p,label,detail){ $('progressBox').classList.remove('hidden'); $('bar').style.width=`${Math.max(0,Math.min(100,p))}%`; $('progressPct').textContent=`${Math.round(p)}%`; $('progressLabel').textContent=label||'מוריד…'; $('progressDetail').textContent=detail||''; }
function setCancelVisible(show){ $('cancelDownload').classList.toggle('hidden',!show); }
function splitChoiceFor(choice){ return choice?.kind==='hls' ? choice : (choice?.hlsAlternative || null); }
function updateSplitAvailability(){
  const c=choices[Number($('quality').value)||0];
  const supported=!!splitChoiceFor(c);
  $('splitDownload').disabled=!supported;
  $('splitOption').classList.toggle('disabled',!supported);
  if(!supported)$('splitDownload').checked=false;
}
function toggleSplitInfo(){
  const help=$('splitHelp');
  const show=help.classList.contains('hidden');
  help.classList.toggle('hidden',!show);
  $('splitInfo').setAttribute('aria-expanded',show?'true':'false');
}

async function scan(){
  if(!activeTab?.id)return;
  setStatus('סורק את העמוד','מחפש וידאו וכתובות מדיה חתומות…');
  await chrome.runtime.sendMessage({type:'scanTab',tabId:activeTab.id}).catch(()=>null);
  await loadStreams();
}

function subtitleTrackId(sub){
  try{
    const p=new URL(sub.url).pathname;
    const m=p.match(/\/(?:captions|sub)\/(\d+)(?:\.|\/|$)/i)||p.match(/\/texttrack\/sub\/(\d+)(?:\.|\/|$)/i);
    return m?.[1]||'';
  }catch(_){return ''}
}
function subtitleUsable(sub){
  try{
    const u=new URL(sub.url);
    if(u.hostname==='captions.vimeo.com' && /\/captions\/\d+\.(?:vtt|srt)$/i.test(u.pathname) && u.searchParams.has('expires') && !u.searchParams.has('sig'))return false;
  }catch(_){return false}
  return true;
}
function subtitleScore(sub){
  let n=0;
  try{
    const u=new URL(sub.url);
    if(/\.(?:vtt|srt)$/i.test(u.pathname))n+=40;
    if(u.searchParams.has('sig'))n+=25;
    if(/\.m3u8$/i.test(u.pathname))n+=15;
  }catch(_){}
  if(sub.source==='playerConfig')n+=8;
  if(sub.language)n+=2;
  return n;
}
function addSubtitle(sub){ if(sub?.url && subtitleUsable(sub)) subtitles.push({...sub,trackId:subtitleTrackId(sub)}); }
function dedupeSubtitles(list){
  const map=new Map();
  for(const s of list){
    const key=s.trackId?`track:${s.trackId}`:`url:${(()=>{try{const u=new URL(s.url);return u.hostname+u.pathname}catch(_){return s.url}})()}`;
    const cur=map.get(key);
    if(!cur||subtitleScore(s)>subtitleScore(cur))map.set(key,s);
  }
  return [...map.values()];
}
function friendlyLanguage(code){
  const c=String(code||'').toLowerCase();
  if(c==='he'||c==='iw'||c.startsWith('he-'))return 'עברית';
  if(c==='en'||c.startsWith('en-'))return 'אנגלית';
  if(c==='ar'||c.startsWith('ar-'))return 'ערבית';
  return code||'';
}
async function inspectSubtitles(){
  await Promise.all(subtitles.map(async s=>{
    const r=await chrome.runtime.sendMessage({type:'inspectSubtitle',url:s.url}).catch(()=>null);
    if(r?.ok&&r.code&&Number(r.confidence||0)>=0.55){
      s.detectedLanguage=r.code;s.detectedLanguageLabel=r.label;s.detectedConfidence=r.confidence;
      if(r.code!==String(s.language||'').split('-')[0].toLowerCase())s.metadataMismatch=true;
    }
  }));
}
function subtitleDisplay(sub){
  const lang=sub.detectedLanguageLabel||friendlyLanguage(sub.language)||'כתוביות';
  const auto=/auto[- ]?generated|autogen|automatic/i.test(`${sub.label||''} ${sub.language||''}`);
  return `${lang}${auto?' • אוטומטי':''}`;
}

async function loadStreams(){
  const r=await chrome.runtime.sendMessage({type:'getStreams',tabId:activeTab.id});
  allItems=r?.items||[];
  $('tech').textContent=allItems.map(x=>{let u='';try{const p=new URL(x.url);u=`${p.origin}${p.pathname}`}catch(_){u='כתובת לא זמינה'}return `${x.type.padEnd(8)} ${x.quality||x.language||''}\n${u}`}).join('\n\n');
  await buildChoices();
}

async function buildChoices(){
  choices=[]; subtitles=[];
  allItems.filter(x=>x.type==='subtitle').forEach(x=>addSubtitle({url:x.url,label:x.label||'כתוביות',language:x.language||'',kind:x.subtitleKind||'',source:x.source||''}));
  const mp4s=allItems.filter(x=>x.type==='mp4' && x.url && !/[?&]range=\d+-\d+/i.test(x.url) && !/\/v2\/range\/prot\//i.test(x.url));
  for(const x of mp4s) choices.push({kind:'direct',label:x.quality|| (x.height?`${x.height}p`:'MP4'),height:x.height||0,bitrate:x.bitrate||0,item:x});

  const hls=allItems.find(x=>x.type==='hls');
  if(hls){
    const ar=await chrome.runtime.sendMessage({type:'analyzeHls',url:hls.url}).catch(e=>({ok:false,error:String(e)}));
    if(ar?.ok){
      for(const v of ar.variants||[]){
        choices.push({kind:'hls',label:v.quality||'HLS',height:v.height||0,bitrate:v.bandwidth||0,item:hls,variant:v});
        (v.subtitles||[]).forEach(addSubtitle);
      }
      (ar.subtitles||[]).forEach(addSubtitle);
    } else if(ar?.error) setStatus('נמצא וידאו, הניתוח נכשל',ar.error);
  }
  subtitles=dedupeSubtitles(subtitles);
  if(subtitles.length) await inspectSubtitles();
  const map=new Map();
  for(const c of choices.sort((a,b)=>(b.height-a.height)||(a.kind==='direct'?-1:1))){
    const key=`${c.height||c.label}`;
    const cur=map.get(key);
    if(!cur){ map.set(key,c); continue; }
    if(c.kind==='direct'&&cur.kind!=='direct'){ c.hlsAlternative=cur; map.set(key,c); continue; }
    if(c.kind==='hls'&&cur.kind==='direct'&&!cur.hlsAlternative) cur.hlsAlternative=c;
  }
  choices=[...map.values()].sort((a,b)=>(b.height-a.height)||(b.bitrate-a.bitrate));
  render();
}

function renderSubtitles(){
  const box=$('subtitleSection'), sel=$('subtitleSelect'); sel.textContent='';
  if(!subtitles.length){box.classList.add('hidden');return;}
  box.classList.remove('hidden'); $('subtitleCount').textContent=subtitles.length===1?'1 זמינה':`${subtitles.length} זמינות`;
  subtitles.forEach((s,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=subtitleDisplay(s);sel.appendChild(o);});
}

function render(){
  const useful=allItems.filter(x=>['mp4','hls'].includes(x.type));
  renderSubtitles();
  if(!choices.length){ $('videoCard').classList.add('hidden'); $('empty').classList.remove('hidden'); setStatus(useful.length?'נמצא סטרים, עדיין מנתח':'ממתין לווידאו','הפעל את הסרטון לכמה שניות ואז סרוק שוב.'); return; }
  $('empty').classList.add('hidden'); $('videoCard').classList.remove('hidden');
  const best=choices[0].item; $('videoTitle').textContent=titleFor(best);
  const bits=[fmtDuration(best.duration),best.height?`${best.width||''}×${best.height}`:''].filter(Boolean); $('videoMeta').textContent=bits.join(' • ')||`${choices.length} איכויות זמינות`;
  $('sourceBadge').textContent=choices.some(c=>c.kind==='direct')?'MP4 / HLS':'HLS';
  if(best.thumbnail){$('thumb').src=best.thumbnail;$('thumbWrap').classList.remove('hidden')}else $('thumbWrap').classList.add('hidden');
  const sel=$('quality');sel.textContent='';
  choices.forEach((c,i)=>{const o=document.createElement('option');o.value=String(i);const suffix=c.kind==='direct'?' • MP4':' • HLS';const est=fmtSize(estimateSize(c));o.textContent=`${c.label}${est?` • ${est}`:''}${suffix}`;sel.appendChild(o)});
  updateSplitAvailability();
  setStatus('מוכן להורדה',`${choices.length} אפשרויות איכות נמצאו.`);
}

async function doDownload(){
  const selected=choices[Number($('quality').value)||0];if(!selected)return;
  const splitRequested=$('splitDownload').checked;
  const c=splitRequested?splitChoiceFor(selected):selected;
  if(splitRequested&&!c){setProgress(0,'לא ניתן לפצל','הורדה מפוצלת זמינה רק כאשר קיים מקור HLS מתאים לאיכות שנבחרה.');return;}
  $('download').disabled=true;$('stallHint').classList.add('hidden');$('downloadText').textContent='מתחיל…';lastTaskUpdateAt=Date.now();currentTaskStatus='starting';currentTaskId=null;currentDirectDownloadId=null;setCancelVisible(true);
  try{
    if(c.kind==='direct'){
      setProgress(8,'מתחיל הורדה','מעביר את הקובץ למנהל ההורדות…');
      const r=await chrome.runtime.sendMessage({type:'downloadDirect',url:c.item.url,filename:`${titleFor(c.item)} - ${c.label}.mp4`});
      if(!r?.ok)throw new Error(r?.error||'ההורדה לא התחילה');
      currentDirectDownloadId=r.downloadId; currentTaskStatus='downloading'; setProgress(10,'מוריד','ההורדה מתבצעת דרך מנהל ההורדות של הדפדפן.'); $('downloadText').textContent='מוריד…';
    }else{
      setProgress(1,'מתחיל',splitRequested?'מכין הורדה מפוצלת…':'פותח את רשימות המדיה…');
      const v=c.variant;const r=await chrome.runtime.sendMessage({type:'startHlsDownload',variantUrl:v.url,audioUrl:v.audio?.url||'',title:titleFor(c.item),quality:selected.label||c.label,split:splitRequested,maxPartBytes:splitRequested?MAX_SPLIT_BYTES:0});
      if(!r?.ok)throw new Error(r?.error||'לא ניתן להתחיל את הורדת הווידאו');
      currentTaskId=r.taskId;$('downloadText').textContent='מוריד…';
    }
  }catch(e){setProgress(0,'שגיאה',String(e?.message||e));$('downloadText').textContent='נסה שוב';$('download').disabled=false;currentTaskStatus='error';setCancelVisible(false);}
}

async function cancelDownload(){
  $('cancelDownload').disabled=true; $('cancelDownload').textContent='מבטל…';
  try{
    if(currentTaskId) await chrome.runtime.sendMessage({type:'cancelTask',taskId:currentTaskId});
    if(Number.isInteger(currentDirectDownloadId)) await chrome.runtime.sendMessage({type:'cancelDirectDownload',downloadId:currentDirectDownloadId});
    currentTaskStatus='cancelled'; currentTaskId=null; currentDirectDownloadId=null; setProgress(0,'בוטל','ההורדה הופסקה והנתונים החלקיים שוחררו.'); $('downloadText').textContent='הורד וידאו'; $('download').disabled=false; setCancelVisible(false);
  }catch(e){setProgress(0,'שגיאה בביטול',String(e?.message||e));}
  finally{$('cancelDownload').disabled=false;$('cancelDownload').textContent='בטל הורדה';}
}

async function downloadSubtitle(){
  const sub=subtitles[Number($('subtitleSelect').value)||0]; if(!sub)return;
  const btn=$('downloadSubtitle');btn.disabled=true;const old=btn.textContent;btn.textContent='מוריד…';
  try{const best=choices[0]?.item||allItems[0]||{};const language=sub.detectedLanguage||sub.language||'';const label=subtitleDisplay(sub);const r=await chrome.runtime.sendMessage({type:'downloadSubtitle',url:sub.url,title:titleFor(best),label,language});if(!r?.ok)throw new Error(r?.error||'לא ניתן להוריד את הכתוביות');btn.textContent='הורד';setTimeout(()=>btn.textContent=old,1200)}
  catch(e){btn.textContent='שגיאה';setStatus('הורדת הכתוביות נכשלה',String(e?.message||e));setTimeout(()=>btn.textContent=old,1800)}finally{btn.disabled=false}
}

chrome.runtime.onMessage.addListener(m=>{
  if(m?.target!=='ui')return;
  if(m.type==='directDownloadUpdate'){
    const d=m.download;if(!Number.isInteger(currentDirectDownloadId)||d.id!==currentDirectDownloadId)return;
    lastTaskUpdateAt=Date.now();
    if(d.state==='in_progress'){
      currentTaskStatus='downloading';
      const pct=d.totalBytes>0?Math.max(1,Math.min(99,100*d.bytesReceived/d.totalBytes)):10;
      setProgress(pct,'מוריד',d.totalBytes>0?`${fmtSize(d.bytesReceived)} מתוך ${fmtSize(d.totalBytes)}`:`התקבלו ${fmtSize(d.bytesReceived)}`);
      setCancelVisible(true);
    } else if(d.state==='complete'){
      currentTaskStatus='done';setProgress(100,'הושלם','הקובץ נשמר במחשב.');$('downloadText').textContent='הושלם';$('download').disabled=false;setCancelVisible(false);currentDirectDownloadId=null;
    } else if(d.state==='interrupted'){
      currentTaskStatus='error';setProgress(0,'ההורדה הופסקה',d.error||'הדפדפן הפסיק את ההורדה.');$('downloadText').textContent='נסה שוב';$('download').disabled=false;setCancelVisible(false);currentDirectDownloadId=null;
    }
    return;
  }
  if(m.type!=='taskUpdate')return;const t=m.task;if(currentTaskId&&t.id!==currentTaskId)return;currentTaskId=t.id;currentTaskStatus=t.status;lastTaskUpdateAt=Date.now();$('stallHint').classList.add('hidden');
  const labels={starting:'מתחיל',preparing:'מכין',downloading:'מוריד',assembling:'מעבד וידאו',saving:'שומר',done:'הושלם',error:'שגיאה',cancelling:'מבטל',cancelled:'בוטל'};setProgress(t.progress||0,labels[t.status]||t.status,t.detail||'');
  const active=['starting','preparing','downloading','assembling','saving','cancelling'].includes(t.status);setCancelVisible(active);
  if(t.status==='done'){$('downloadText').textContent='הושלם';$('download').disabled=false;setCancelVisible(false)}
  if(t.status==='error'){$('downloadText').textContent='נסה שוב';$('download').disabled=false;setCancelVisible(false)}
  if(t.status==='cancelled'){$('downloadText').textContent='הורד וידאו';$('download').disabled=false;setCancelVisible(false);currentTaskId=null}
});

setInterval(()=>{if(!['starting','preparing','downloading','assembling','saving'].includes(currentTaskStatus)||!lastTaskUpdateAt)return;if(Date.now()-lastTaskUpdateAt>30000)$('stallHint').classList.remove('hidden')},5000);

async function downloadDebug(){
  const r=await chrome.runtime.sendMessage({type:'getDebugBundle',tabId:activeTab?.id}).catch(e=>({ok:false,error:String(e)}));
  const payload={exportedAt:new Date().toISOString(),extension:'Video Catcher',version:chrome.runtime.getManifest().version,userAgent:navigator.userAgent,activeTab:activeTab?{id:activeTab.id,title:activeTab.title,url:activeTab.url}:null,ui:{currentTaskId,currentTaskStatus,lastTaskUpdateAt,splitDownload:$('splitDownload').checked,choiceCount:choices.length,subtitleCount:subtitles.length,choices:choices.map(c=>({kind:c.kind,label:c.label,height:c.height,bitrate:c.bitrate,splitAvailable:!!splitChoiceFor(c)})),subtitles:subtitles.map(s=>({trackId:s.trackId||subtitleTrackId(s),label:s.label||'',metadataLanguage:s.language||'',detectedLanguage:s.detectedLanguage||'',detectedLanguageLabel:s.detectedLanguageLabel||'',detectedConfidence:s.detectedConfidence||0,metadataMismatch:!!s.metadataMismatch,source:s.source||'',url:(()=>{try{const u=new URL(s.url);return `${u.origin}${u.pathname}`}catch(_){return ''}})()}))},backend:r};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`video-catcher-debug-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}

async function init(){
  $('versionLabel').textContent=`v${chrome.runtime.getManifest().version}`;
  const r=await chrome.runtime.sendMessage({type:'getActiveTab'});activeTab=r?.tab;if(!activeTab?.id){setStatus('אין כרטיסייה פעילה','פתח את עמוד השיעור ונסה שוב.');return;}$('pageLine').textContent=activeTab.url||'';await scan();
}
$('refresh').onclick=scan;$('scanAgain').onclick=scan;$('download').onclick=doDownload;$('cancelDownload').onclick=cancelDownload;$('downloadSubtitle').onclick=downloadSubtitle;$('downloadDebug').onclick=downloadDebug;$('quality').onchange=updateSplitAvailability;$('splitInfo').onclick=toggleSplitInfo;$('clear').onclick=async()=>{await chrome.runtime.sendMessage({type:'clearStreams',tabId:activeTab.id});allItems=[];choices=[];subtitles=[];render()};init();
