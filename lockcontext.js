const LOCKED_CONTEXT_KEY = 'vsc_locked_context_by_window';
const UPDATE_CACHE_KEY = 'vsc_update_check';
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const LATEST_RELEASE_API = 'https://api.github.com/repos/WillyW0nka99/VideoCatcher/releases/latest';
const LATEST_RELEASE_PAGE = 'https://github.com/WillyW0nka99/VideoCatcher/releases/latest';

async function lockedWindowId(){
  if(panelWindowId!=null)return panelWindowId;
  try{const w=await chrome.windows.getCurrent();panelWindowId=w?.id??null}catch(_){}
  return panelWindowId;
}

async function tabSnapshotById(tabId){
  try{
    const tab=await chrome.tabs.get(Number(tabId));
    return tab?{id:tab.id,windowId:tab.windowId,index:tab.index,url:tab.url||'',title:tab.title||''}:null;
  }catch(_){return null;}
}

async function saveLockedContext(tab){
  const windowId=await lockedWindowId();
  if(windowId==null||!tab?.id)return;
  const d=await chrome.storage.session.get(LOCKED_CONTEXT_KEY).catch(()=>({}));
  const map={...(d?.[LOCKED_CONTEXT_KEY]||{})};
  map[String(windowId)]={tabId:tab.id,lockedAt:Date.now()};
  await chrome.storage.session.set({[LOCKED_CONTEXT_KEY]:map}).catch(()=>{});
}

async function savedLockedContext(){
  const windowId=await lockedWindowId();
  if(windowId==null)return null;
  const d=await chrome.storage.session.get(LOCKED_CONTEXT_KEY).catch(()=>({}));
  const saved=d?.[LOCKED_CONTEXT_KEY]?.[String(windowId)];
  if(!Number.isInteger(saved?.tabId))return null;
  const tab=await tabSnapshotById(saved.tabId);
  return tab?.windowId===windowId?tab:null;
}

function isSupportedPage(tab){
  try{
    const u=new URL(String(tab?.url||''));
    const host=u.hostname.toLowerCase();
    return u.protocol==='https:' && (host==='ac.il' || host.endsWith('.ac.il'));
  }catch(_){return false;}
}

function showUnsupportedSite(tab){
  $('tabContext').classList.add('unsupported');
  $('tabContextLabel').textContent='אתר זה לא נתמך';
  $('tabTitle').textContent='Video Catcher אינו פעיל באתר הנוכחי';
  $('pageLine').textContent='';
  $('videoCard').classList.add('hidden');
  $('empty').classList.add('hidden');
  setStatus('אתר זה לא נתמך','עבור לאתר נתמך ולחץ על ↻ כדי לעבור אליו.');
}

renderTabContext = function(tab){
  if(!isSupportedPage(tab)){
    showUnsupportedSite(tab);
    return;
  }
  $('tabContext').classList.remove('unsupported');
  const number=Number.isInteger(tab?.index)?tab.index+1:null;
  $('tabContextLabel').textContent=number?`חלונית ${number} • נעולה`:'חלונית נעולה';
  $('tabTitle').textContent=tab?.title||'עמוד נתמך';
  $('pageLine').textContent=tab?.url||'';
};

async function restoreLockedTask(){
  if(!activeTab?.id||!isSupportedPage(activeTab))return;
  const r=await chrome.runtime.sendMessage({type:'getTasks'}).catch(()=>null);
  const tasks=Object.values(r?.tasks||{}).filter(t=>Number(t?.tabId)===activeTab.id&&normalizePageUrl(t?.pageUrl||'')===normalizePageUrl(activeTab.url||''));
  tasks.sort((a,b)=>Number(b?.updatedAt||b?.startedAt||0)-Number(a?.updatedAt||a?.startedAt||0));
  const t=tasks[0];
  if(!t)return;
  currentTaskId=t.id;
  currentTaskStatus=t.status;
  lastTaskUpdateAt=Number(t.updatedAt||Date.now());
  $('stallHint').classList.add('hidden');
  const labels={starting:'מתחיל',preparing:'מכין',downloading:'מוריד',assembling:'מעבד וידאו',saving:'שומר',done:'הושלם',error:'שגיאה',cancelling:'מבטל',cancelled:'בוטל'};
  setProgress(t.progress||0,labels[t.status]||t.status,t.detail||'');
  const running=['starting','preparing','downloading','assembling','saving','cancelling'].includes(t.status);
  setCancelVisible(running);
  if(running){$('downloadText').textContent='מוריד…';$('download').disabled=true;}
  if(t.status==='done'){$('downloadText').textContent='הורד שוב';$('download').disabled=false;setCancelVisible(false);}
  if(t.status==='error'){$('downloadText').textContent='נסה שוב';$('download').disabled=false;setCancelVisible(false);}
  if(t.status==='cancelled'){$('downloadText').textContent='הורד וידאו';$('download').disabled=false;setCancelVisible(false);currentTaskId=null;}
}

scanCurrentTab = async function(){
  if(!activeTab?.id)return;
  if(!isSupportedPage(activeTab)){
    showUnsupportedSite(activeTab);
    return;
  }
  $('tabContext').classList.remove('unsupported');
  const expectedKey=contextKey;
  setStatus('סורק את החלונית הנעולה','מחפש וידאו וכתובות מדיה בחלונית שמופיעה למעלה…');
  await chrome.runtime.sendMessage({type:'scanTab',tabId:activeTab.id}).catch(()=>null);
  if(expectedKey!==contextKey)return;
  await loadStreams(expectedKey);
  if(expectedKey===contextKey)await restoreLockedTask();
};

// מעבר בין חלוניות אינו משנה את ההקשר. רק כפתור הרענון מאמץ חלונית חדשה.
syncActiveTab = async function(){ return !!activeTab?.id; };

async function adoptActiveWindowAndScan(){
  const next=await getActiveTabSnapshot();
  if(!next?.id){setStatus('אין חלונית פעילה','פתח עמוד נתמך ונסה שוב.');return;}
  const nextKey=contextKeyFor(next);
  if(nextKey!==contextKey){
    activeTab=next;
    contextKey=nextKey;
    resetContextUi();
  }else activeTab=next;
  renderTabContext(activeTab);
  await saveLockedContext(activeTab);
  await scanCurrentTab();
}

async function rescanLockedWindow(){
  if(!activeTab?.id){await adoptActiveWindowAndScan();return;}
  const latest=await tabSnapshotById(activeTab.id);
  if(!latest){setStatus('החלונית הנעולה נסגרה','עבור לחלונית אחרת ולחץ על כפתור הרענון למעלה.');return;}
  const nextKey=contextKeyFor(latest);
  if(nextKey!==contextKey){
    activeTab=latest;
    contextKey=nextKey;
    resetContextUi();
  }else activeTab=latest;
  renderTabContext(activeTab);
  await saveLockedContext(activeTab);
  await scanCurrentTab();
}

function versionParts(value){
  const m=String(value||'').match(/(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
  return m?[Number(m[1]),Number(m[2]),Number(m[3]),Number(m[4]||0)]:null;
}

function isNewerVersion(remote,local){
  const a=versionParts(remote),b=versionParts(local);
  if(!a||!b)return false;
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const av=a[i]||0,bv=b[i]||0;
    if(av!==bv)return av>bv;
  }
  return false;
}

function safeReleaseUrl(value){
  const s=String(value||'');
  return /^https:\/\/github\.com\/WillyW0nka99\/VideoCatcher\/releases\//i.test(s)?s:LATEST_RELEASE_PAGE;
}

function showUpdateNotice(release){
  if($('updateNotice'))return;
  const a=document.createElement('a');
  a.id='updateNotice';
  a.className='updateNotice';
  a.href=safeReleaseUrl(release?.url);
  a.target='_blank';
  a.rel='noopener noreferrer';
  a.textContent='קיימת גרסה חדשה — לחץ להורדה';
  a.title=`גרסה חדשה זמינה: ${release?.version||''}`.trim();
  $('versionLabel').insertAdjacentElement('afterend',a);
}

async function latestReleaseInfo(){
  const now=Date.now();
  const stored=await chrome.storage.local.get(UPDATE_CACHE_KEY).catch(()=>({}));
  const cached=stored?.[UPDATE_CACHE_KEY];
  if(cached?.checkedAt && now-cached.checkedAt<UPDATE_CHECK_INTERVAL_MS)return cached.release||null;
  try{
    const r=await fetch(LATEST_RELEASE_API,{headers:{Accept:'application/vnd.github+json'},cache:'no-store'});
    if(!r.ok)throw new Error(`GitHub HTTP ${r.status}`);
    const data=await r.json();
    const version=versionParts(data?.tag_name)?.slice(0,3).join('.')||'';
    const release={version,url:safeReleaseUrl(data?.html_url),tag:String(data?.tag_name||'')};
    await chrome.storage.local.set({[UPDATE_CACHE_KEY]:{checkedAt:now,release}}).catch(()=>{});
    return release;
  }catch(_){
    return cached?.release||null;
  }
}

async function checkForUpdate(){
  const release=await latestReleaseInfo();
  const local=chrome.runtime.getManifest().version;
  if(release?.version&&isNewerVersion(release.version,local))showUpdateNotice(release);
}

$('refresh').onclick=adoptActiveWindowAndScan;
$('scanAgain').onclick=rescanLockedWindow;
$('clear').onclick=async()=>{
  if(!activeTab?.id)return;
  await chrome.runtime.sendMessage({type:'clearStreams',tabId:activeTab.id});
  resetContextUi();
  renderTabContext(activeTab);
  if(isSupportedPage(activeTab))setStatus('נוקו הזיהויים','לחץ על סריקה מחדש כדי לחפש שוב בחלונית הנעולה.');
};

checkForUpdate().catch(()=>{});

(async()=>{
  // אם ה-Side Panel נוצר מחדש, החזר אותו לחלונית שאליה היה נעול.
  const saved=await savedLockedContext();
  if(saved){
    const savedKey=contextKeyFor(saved);
    if(savedKey!==contextKey){
      activeTab=saved;
      contextKey=savedKey;
      resetContextUi();
    }else activeTab=saved;
    renderTabContext(activeTab);
    await scanCurrentTab();
    return;
  }
  // בהפעלה הראשונה נעל לחלונית שכבר נבחרה על ידי הקוד הראשי.
  for(let i=0;i<40&&!activeTab?.id;i++)await new Promise(r=>setTimeout(r,25));
  if(activeTab?.id){renderTabContext(activeTab);await saveLockedContext(activeTab);}
})();
