'use strict';
const $=id=>document.getElementById(id);
const api=window.videoMD;
let settings={},queueState={items:[]},selectedId=null;
function showError(message){$('alert').textContent=message;$('alert').hidden=!message;}
async function call(method,...args){const result=await api[method](...args);if(!result.ok)throw new Error(result.error);return result.value;}
function getSettings(){return {projectId:$('project').value,expectedAccount:$('account').value,outputDirectory:$('folder').value,adcFile:$('adc').value,model:$('model').value,subscription:$('subscription').value,budgetId:$('budget').value};}
function fillSettings(value){settings=value;$('project').value=value.projectId||'';$('account').value=value.expectedAccount||'';$('folder').value=value.outputDirectory||'';$('adc').value=value.adcFile||'';$('model').value=value.model||'gemini-3.8-flash';$('subscription').value=value.subscription||'';$('budget').value=value.budgetId||'';}
const phaseNames={idle:'待機中',queued:'順番待ち',paused:'再開待ち',auth:'接続確認',metadata:'情報取得',transcribing:'文字起こし',tags:'タグ生成',saving:'保存中',complete:'完了',cancelled:'キャンセル',error:'失敗'};
function updateQueue(state){
  queueState=state;
  $('capacity').textContent=`あと${state.availableSlots??2}本を同時処理できます。あと${state.availablePending??20}本を待機登録できます。`;
  $('parallel-info').textContent=`実行中 ${state.activeCount||0}本 / 待機 ${state.pendingCount||0}本。API処理は全動画合計で最大${state.apiLimit||2}件${state.apiLimit===1?'（混雑を検出したため安定性を優先）':''}。同時処理枠はアプリの設定です。`;
  if(!state.items?.some(item=>item.id===selectedId))selectedId=state.items?.at(-1)?.id;
  $('jobs').replaceChildren();
  for(const item of state.items||[]){
    const row=document.createElement('div');row.className='job-row'+(item.id===selectedId?' selected':'');
    const title=document.createElement('p');title.textContent=item.metadata?.title||item.url;
    const status=document.createElement('small');status.textContent=`${phaseNames[item.phase]||item.phase} · ${Math.round((item.progress||0)*100)}% · ${item.message||''}`;
    const actions=document.createElement('div');actions.className='actions';
    const button=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.addEventListener('click',()=>action(fn));actions.append(b);};
    button('詳細',()=>{selectedId=item.id;updateQueue(queueState);});
    if(item.canResume&&!['queued','auth','metadata','transcribing','tags','saving'].includes(item.phase))button('再開',()=>call('start',{id:item.id,resume:true}));
    if(['queued','auth','metadata','transcribing','tags','saving'].includes(item.phase))button('取消',()=>call('cancel',item.id));
    if(item.outputPath)button('Markdownを開く',()=>call('openOutput',item.id));
    row.append(title,status,actions);$('jobs').append(row);
  }
  const selected=state.items?.find(item=>item.id===selectedId);
  updateState(selected||{phase:'idle',message:state.message||'URLを入力して動画を追加してください。',progress:0});
  $('start').disabled=(state.availablePending===0&&state.availableSlots===0);
  $('model').disabled=Boolean(state.busy);$('save-settings').disabled=Boolean(state.busy);$('url').disabled=false;
}
function updateState(state){state={...state,busy:['auth','metadata','transcribing','tags','saving'].includes(state.phase)};$('metadata').hidden=!state.metadata;$('preview-card').hidden=!state.preview;$('estimate').textContent='—';$('phase').textContent=phaseNames[state.phase]||state.phase;$('status').textContent=state.message;$('progress').value=state.progress||0;$('start').disabled=state.busy;$('model').disabled=state.busy;$('url').disabled=state.busy;$('save-settings').disabled=state.busy;$('cancel').hidden=!state.busy;$('resume').hidden=state.busy||!state.canResume;$('open-output').hidden=!state.outputPath;$('open-folder').hidden=!state.outputPath;$('output-path').textContent=state.outputPath||'';if(state.metadata){$('metadata').hidden=false;$('video-title').textContent=state.metadata.title;$('video-channel').textContent=state.metadata.channel;$('video-date').textContent=`${new Date(state.metadata.publishedAt).toLocaleString('ja-JP')} / ${Math.floor(state.metadata.durationSeconds/60)}分${state.metadata.durationSeconds%60}秒`;}if(Number.isFinite(state.estimatedUsd))$('estimate').textContent='$'+state.estimatedUsd.toFixed(4);if(state.preview){$('preview-card').hidden=false;$('preview').textContent=state.preview;}if(state.error)showError(state.error);}
function updateBilling(state){$('billing-cost').textContent=state.connected===false||!Number.isFinite(state.cost)?'未接続':state.cost.toLocaleString('ja-JP',{style:'currency',currency:'JPY'});$('billing-message').textContent=state.message||'円建ての月内利用料金。費用反映には遅延があります。';if(state.history?.length){$('billing-history').replaceChildren();for(const item of state.history.slice(-30).reverse()){const li=document.createElement('li');li.textContent=typeof item==='string'?item:JSON.stringify(item);$('billing-history').append(li);}}}
async function action(fn){showError('');try{await fn();}catch(error){showError(error.message);}}
$('settings-toggle').addEventListener('click',()=>{const hidden=!$('settings-panel').hidden;$('settings-panel').hidden=hidden;$('settings-toggle').setAttribute('aria-expanded',String(!hidden));});
$('choose-folder').addEventListener('click',()=>action(async()=>{const value=await call('chooseFolder');if(value)$('folder').value=value;}));
$('choose-adc').addEventListener('click',()=>action(async()=>{const value=await call('chooseAdc');if(value)$('adc').value=value;}));
$('clear-adc').addEventListener('click',()=>{$('adc').value='';});
$('save-settings').addEventListener('click',()=>action(async()=>{fillSettings(await call('saveSettings',getSettings()));$('settings-message').textContent='設定を保存しました。';}));
$('verify').addEventListener('click',()=>action(async()=>{fillSettings(await call('saveSettings',getSettings()));$('settings-message').textContent='照合しています…';const value=await call('verifyAuth');$('settings-message').textContent='接続確認済み：'+value.email;}));
async function start(resume){if(resume){await call('start',{id:selectedId,resume:true});return;}fillSettings(await call('saveSettings',getSettings()));await call('start',{urls:$('url').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)});$('url').value='';}
$('start').addEventListener('click',()=>action(()=>start(false)));
$('resume').addEventListener('click',()=>action(()=>start(true)));
$('cancel').addEventListener('click',()=>action(()=>call('cancel',selectedId)));
$('open-output').addEventListener('click',()=>action(()=>call('openOutput',selectedId)));
$('open-folder').addEventListener('click',()=>action(()=>call('openFolder',selectedId)));
$('billing-refresh').addEventListener('click',()=>action(()=>call('pollBilling')));
$('quit').addEventListener('click',()=>action(()=>call('quit')));
if(api){api.onState(updateQueue);api.onBilling(updateBilling);action(async()=>{const initial=await call('getInitial');fillSettings(initial.settings);updateQueue(initial.state);updateBilling(initial.billing);$('version').textContent=initial.version;if(!settings.projectId){$('settings-panel').hidden=false;$('settings-toggle').setAttribute('aria-expanded','true');}});}else{$('status').textContent='Windowsアプリ内で開いてください。';$('start').disabled=true;}
