const LOCKED_CONTEXT_KEY = 'vsc_locked_context_by_window';

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

renderTabContext = function(tab){
  const number=Number.isInteger(tab?.index)?tab.index+1:null;
  $('tabContextLabel').textContent=number?`חלונית ${number} • נעולה`:'חלונית נעולה';
  $('tabTitle').textContent=tab?.title||'ללא כותרת';
  $('pageLine').textContent=tab?.url||'כתובת לא זמינה';
};

async function restoreLockedTask(){
  if(!activeTab?.id)return;
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
  const expectedKey=contextKey;
  setStatus('סורק את החלונית הנעולה','מחפש וידאו וכתובות מדיה בחלונית שמופיעה למעלה…');
  await chrome.runtime.sendMessage({type:'scanTab',tabId:activeTab.id}).catch(()=>null);
  if(expectedKey!==contextKey)return;
  await loadStreams(expectedKey);
  if(expectedKey===contextKey)await restoreLockedTask();
};

// התראות על מעבר בין חלוניות אינן משנות את ההקשר.
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

$('refresh').onclick=adoptActiveWindowAndScan;
$('scanAgain').onclick=rescanLockedWindow;
$('clear').onclick=async()=>{
  if(!activeTab?.id)return;
  await chrome.runtime.sendMessage({type:'clearStreams',tabId:activeTab.id});
  resetContextUi();
  renderTabContext(activeTab);
  setStatus('נוקו הזיהויים','לחץ על סריקה מחדש כדי לחפש שוב בחלונית הנעולה.');
};

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
