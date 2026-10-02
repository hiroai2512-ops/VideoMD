'use strict';
const $=id=>document.getElementById(id);
const api=window.videoMD;
let settings={},queueState={items:[]},selectedId=null,adding=false;
function showError(message){$('alert').textContent=message;$('alert').hidden=!message;}
async function call(method,...args){const result=await api[method](...args);if(!result.ok)throw new Error(result.error);return result.value;}
function getSettings(){return {projectId:$('project').value,expectedAccount:$('account').value,outputDirectory:$('folder').value,adcFile:$('adc').value,model:$('model').value,subscription:$('subscription').value,budgetId:$('budget').value};}
function fillSettings(value){settings=value;$('project').value=value.projectId||'';$('account').value=value.expectedAccount||'';$('folder').value=value.outputDirectory||'';$('adc').value=value.adcFile||'';$('model').value=value.model||'gemini-3.8-flash';$('subscription').value=value.subscription||'';$('budget').value=value.budgetId||'';}
const phaseNames={idle:'待機中',queued:'順番待ち',paused:'再開待ち',running:'処理中',auth:'接続確認',metadata:'情報取得',transcribing:'文字起こし',tags:'タグ生成',saving:'保存中',complete:'完了',cancelled:'取消済み',error:'失敗'};
const activePhases=['running','auth','metadata','transcribing','tags','saving'];
const isActive=item=>typeof item.active==='boolean'?item.active:activePhases.includes(item.phase);
const titleOf=item=>item.metadata?.title||item.url||'動画';
function selectJob(id){selectedId=id;updateQueue(queueState);}
function button(label,fn,disabled=false){const element=document.createElement('button');element.type='button';element.textContent=label;element.disabled=disabled;element.addEventListener('click',()=>action(fn));return element;}
function emptyList(target,message){const p=document.createElement('p');p.className='empty-state';p.textContent=message;target.append(p);}
function jobCard(item,type,index,total){
  const card=document.createElement('article');card.className='job-row '+type+(item.id===selectedId?' selected':'');card.dataset.jobId=item.id;
  const title=button(titleOf(item),()=>selectJob(item.id));title.className='job-title';title.title=titleOf(item);title.setAttribute('aria-label',titleOf(item)+'の詳細');card.append(title);
  if(item.metadata?.title){const url=document.createElement('p');url.className='job-url';url.textContent=item.url;card.append(url);}
  const status=document.createElement('p');status.className='job-status';status.textContent=(type==='pending'?(index+1)+'番目 · ':'')+(phaseNames[item.phase]||item.phase)+(type==='active'?' · '+Math.round((item.progress||0)*100)+'%':'');card.append(status);
  if(type==='active'){
    const progress=document.createElement('progress');progress.max=1;progress.value=item.progress||0;progress.setAttribute('aria-label',titleOf(item)+'の進捗');card.append(progress);
    const message=document.createElement('p');message.className='hint job-message';message.textContent=item.message||'';card.append(message);
  }
  const actions=document.createElement('div');actions.className='actions';
  if(type==='pending'){
    const up=button('上へ',()=>call('moveQueued',item.id,-1),index===0);
    const down=button('下へ',()=>call('moveQueued',item.id,1),index===total-1);
    up.setAttribute('aria-label',titleOf(item)+'を上へ');down.setAttribute('aria-label',titleOf(item)+'を下へ');actions.append(up,down);
  }
  if(type==='active'||type==='pending')actions.append(button('取消',()=>call('cancel',item.id)));
  if(type==='held')actions.append(button('再開',()=>call('start',{id:item.id,resume:true}),!item.canResume));
  if(type==='complete'){
    actions.append(button('Markdownを開く',()=>call('openOutput',item.id),!item.outputPath),button('保存フォルダを開く',()=>call('openFolder',item.id),!item.outputPath));
    if(!item.outputPath){const note=document.createElement('p');note.className='hint';note.textContent='保存先の情報がありません。';card.append(note);}
  }
  card.append(actions);return card;
}
function renderList(id,items,type,message){const target=$(id);target.replaceChildren();if(!items.length)emptyList(target,message);items.forEach((item,index)=>target.append(jobCard(item,type,index,items.length)));}
function updateQueue(state){
  queueState=state;const items=state.items||[];
  const active=items.filter(isActive),pending=items.filter(item=>!isActive(item)&&item.phase==='queued'),complete=items.filter(item=>!isActive(item)&&item.phase==='complete'),held=items.filter(item=>!isActive(item)&&!['queued','complete'].includes(item.phase));
  const limit=state.effectiveMaxActive??state.maxActive??2;
  $('capacity').textContent='あと'+(state.availableSlots??Math.max(0,limit-active.length))+'本を同時処理できます。あと'+(state.availablePending??100)+'本を待機登録できます。';
  $('parallel-info').textContent='実行中 '+active.length+'本 / 同時処理 '+limit+'本'+(limit===1?'（混雑を検出したため1本に縮退）':'')+'。API処理は全動画合計で最大'+(state.apiLimit||2)+'件。同時処理枠はアプリの設定で、Googleの処理能力を保証するものではありません。';
  $('active-count').textContent=active.length+' / '+limit+'本';$('pending-count').textContent=pending.length+' / '+(state.maxPending??100)+'本';$('history-count').textContent=complete.length+'本';$('held-count').textContent=held.length+'本';
  if(!items.some(item=>item.id===selectedId))selectedId=(active[0]||pending[0]||held[0]||complete.at(-1))?.id||null;
  renderList('jobs',active,'active','処理中の動画はありません。URLを追加すると開始します。');
  renderList('pending-jobs',pending,'pending','待機中の動画はありません。');
  renderList('completed-jobs',[...complete].reverse(),'complete','完了した動画がここに並びます。');
  renderList('held-jobs',held,'held','再開待ちの動画はありません。');
  const select=$('job-select');select.replaceChildren();
  if(!items.length){const option=document.createElement('option');option.value='';option.textContent='動画がありません';select.append(option);}
  for(const item of [...active,...pending,...held,...complete]){const option=document.createElement('option');option.value=item.id;option.textContent=(phaseNames[item.phase]||item.phase)+' · '+titleOf(item);select.append(option);}
  select.value=selectedId||'';select.disabled=!items.length;
  updateState(items.find(item=>item.id===selectedId)||{phase:'idle',message:state.message||'URLを入力して動画を追加してください。',progress:0});
  const busy=Boolean(state.busy)||active.length>0;
  $('start').disabled=adding||(state.availablePending===0&&state.availableSlots===0);$('url').disabled=false;
  for(const id of ['model','project','account','folder','adc','subscription','budget','choose-folder','choose-adc','clear-adc','save-settings','verify'])$(id).disabled=busy;
  $('settings-lock').hidden=!busy;
}
function updateState(state){
  const active=isActive(state),queued=state.phase==='queued';
  $('metadata').hidden=!state.metadata;$('preview-card').hidden=!state.preview;$('estimate').textContent='—';
  $('phase').textContent=phaseNames[state.phase]||state.phase;$('status').textContent=state.message||'';$('progress').value=state.progress||0;
  $('cancel').hidden=!active&&!queued;$('resume').hidden=active||queued||state.phase==='complete'||!state.canResume;
  $('open-output').hidden=state.phase!=='complete'&&!state.outputPath;$('open-folder').hidden=$('open-output').hidden;
  $('open-output').disabled=!state.outputPath;$('open-folder').disabled=!state.outputPath;$('output-path').textContent=state.outputPath||'';
  if(state.metadata){$('video-title').textContent=state.metadata.title||'';$('video-channel').textContent=state.metadata.channel||'';$('video-date').textContent=new Date(state.metadata.publishedAt).toLocaleString('ja-JP')+' / '+Math.floor(state.metadata.durationSeconds/60)+'分'+state.metadata.durationSeconds%60+'秒';}
  if(Number.isFinite(state.estimatedUsd))$('estimate').textContent='$'+state.estimatedUsd.toFixed(4);
  if(state.preview)$('preview').textContent=state.preview;
  if(state.error)showError(state.error);
}
function updateBilling(state){$('billing-cost').textContent=state.connected===false||!Number.isFinite(state.cost)?'未接続':state.cost.toLocaleString('ja-JP',{style:'currency',currency:'JPY'});$('billing-message').textContent=state.message||'円建ての月内利用料金。費用反映には遅延があります。';if(state.history?.length){$('billing-history').replaceChildren();for(const item of state.history.slice(-30).reverse()){const li=document.createElement('li');li.textContent=typeof item==='string'?item:JSON.stringify(item);$('billing-history').append(li);}}}
async function action(fn){showError('');try{await fn();}catch(error){showError(error.message);}}
$('settings-toggle').addEventListener('click',()=>{const hidden=!$('settings-panel').hidden;$('settings-panel').hidden=hidden;$('settings-toggle').setAttribute('aria-expanded',String(!hidden));});
$('job-select').addEventListener('change',()=>selectJob($('job-select').value));
$('choose-folder').addEventListener('click',()=>action(async()=>{const value=await call('chooseFolder');if(value)$('folder').value=value;}));
$('choose-adc').addEventListener('click',()=>action(async()=>{const value=await call('chooseAdc');if(value)$('adc').value=value;}));
$('clear-adc').addEventListener('click',()=>{$('adc').value='';});
$('save-settings').addEventListener('click',()=>action(async()=>{fillSettings(await call('saveSettings',getSettings()));$('settings-message').textContent='設定を保存しました。';}));
$('verify').addEventListener('click',()=>action(async()=>{fillSettings(await call('saveSettings',getSettings()));$('settings-message').textContent='照合しています…';const value=await call('verifyAuth');$('settings-message').textContent='接続確認済み：'+value.email;}));
async function start(resume){
  if(resume){await call('start',{id:selectedId,resume:true});return;}
  const submitted=$('url').value;adding=true;updateQueue(queueState);
  try{fillSettings(await call('saveSettings',getSettings()));await call('start',{urls:submitted.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)});if($('url').value===submitted)$('url').value='';}
  finally{adding=false;updateQueue(queueState);}
}
$('start').addEventListener('click',()=>action(()=>start(false)));
$('resume').addEventListener('click',()=>action(()=>start(true)));
$('cancel').addEventListener('click',()=>action(()=>call('cancel',selectedId)));
$('open-output').addEventListener('click',()=>action(()=>call('openOutput',selectedId)));
$('open-folder').addEventListener('click',()=>action(()=>call('openFolder',selectedId)));
$('billing-refresh').addEventListener('click',()=>action(()=>call('pollBilling')));
$('quit').addEventListener('click',()=>action(()=>call('quit')));
if(api){api.onState(updateQueue);api.onBilling(updateBilling);action(async()=>{const initial=await call('getInitial');fillSettings(initial.settings);updateQueue(initial.state);updateBilling(initial.billing);$('version').textContent=initial.version;if(!settings.projectId){$('settings-panel').hidden=false;$('settings-toggle').setAttribute('aria-expanded','true');}});}else{updateQueue({items:[]});$('status').textContent='Windowsアプリ内で開いてください。';$('start').disabled=true;}
