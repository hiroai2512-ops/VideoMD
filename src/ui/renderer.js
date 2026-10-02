'use strict';
const $=id=>document.getElementById(id);
const api=window.videoMD;
let settings={};
function showError(message){$('alert').textContent=message;$('alert').hidden=!message;}
async function call(method,...args){const result=await api[method](...args);if(!result.ok)throw new Error(result.error);return result.value;}
function getSettings(){return {projectId:$('project').value,expectedAccount:$('account').value,outputDirectory:$('folder').value,adcFile:$('adc').value,model:$('model').value,subscription:$('subscription').value,budgetId:$('budget').value};}
function fillSettings(value){settings=value;$('project').value=value.projectId||'';$('account').value=value.expectedAccount||'';$('folder').value=value.outputDirectory||'';$('adc').value=value.adcFile||'';$('model').value=value.model||'gemini-3.8-flash';$('subscription').value=value.subscription||'';$('budget').value=value.budgetId||'';}
const phaseNames={idle:'待機中',auth:'接続確認',metadata:'情報取得',transcribing:'文字起こし',tags:'タグ生成',saving:'保存中',complete:'完了',cancelled:'キャンセル',error:'失敗'};
function updateState(state){$('phase').textContent=phaseNames[state.phase]||state.phase;$('status').textContent=state.message;$('progress').value=state.progress||0;$('start').disabled=state.busy;$('model').disabled=state.busy;$('url').disabled=state.busy;$('save-settings').disabled=state.busy;$('cancel').hidden=!state.busy;$('resume').hidden=state.busy||!state.canResume;$('open-output').hidden=!state.outputPath;$('open-folder').hidden=!state.outputPath;$('output-path').textContent=state.outputPath||'';if(state.metadata){$('metadata').hidden=false;$('video-title').textContent=state.metadata.title;$('video-channel').textContent=state.metadata.channel;$('video-date').textContent=`${new Date(state.metadata.publishedAt).toLocaleString('ja-JP')} / ${Math.floor(state.metadata.durationSeconds/60)}分${state.metadata.durationSeconds%60}秒`;}if(Number.isFinite(state.estimatedUsd))$('estimate').textContent='$'+state.estimatedUsd.toFixed(4);if(state.preview){$('preview-card').hidden=false;$('preview').textContent=state.preview;}if(state.error)showError(state.error);}
function updateBilling(state){$('billing-cost').textContent=state.connected===false||!Number.isFinite(state.cost)?'未接続':state.cost.toLocaleString('ja-JP',{style:'currency',currency:'JPY'});$('billing-message').textContent=state.message||'円建ての月内利用料金。費用反映には遅延があります。';if(state.history?.length){$('billing-history').replaceChildren();for(const item of state.history.slice(-30).reverse()){const li=document.createElement('li');li.textContent=typeof item==='string'?item:JSON.stringify(item);$('billing-history').append(li);}}}
async function action(fn){showError('');try{await fn();}catch(error){showError(error.message);}}
$('settings-toggle').addEventListener('click',()=>{const hidden=!$('settings-panel').hidden;$('settings-panel').hidden=hidden;$('settings-toggle').setAttribute('aria-expanded',String(!hidden));});
$('choose-folder').addEventListener('click',()=>action(async()=>{const value=await call('chooseFolder');if(value)$('folder').value=value;}));
$('choose-adc').addEventListener('click',()=>action(async()=>{const value=await call('chooseAdc');if(value)$('adc').value=value;}));
$('clear-adc').addEventListener('click',()=>{$('adc').value='';});
$('save-settings').addEventListener('click',()=>action(async()=>{fillSettings(await call('saveSettings',getSettings()));$('settings-message').textContent='設定を保存しました。';}));
$('verify').addEventListener('click',()=>action(async()=>{fillSettings(await call('saveSettings',getSettings()));$('settings-message').textContent='照合しています…';const value=await call('verifyAuth');$('settings-message').textContent='接続確認済み：'+value.email;}));
async function start(resume){fillSettings(await call('saveSettings',getSettings()));await call('start',{url:$('url').value,resume});}
$('start').addEventListener('click',()=>action(()=>start(false)));
$('resume').addEventListener('click',()=>action(()=>start(true)));
$('cancel').addEventListener('click',()=>action(()=>call('cancel')));
$('open-output').addEventListener('click',()=>action(()=>call('openOutput')));
$('open-folder').addEventListener('click',()=>action(()=>call('openFolder')));
$('billing-refresh').addEventListener('click',()=>action(()=>call('pollBilling')));
$('quit').addEventListener('click',()=>action(()=>call('quit')));
if(api){api.onState(updateState);api.onBilling(updateBilling);action(async()=>{const initial=await call('getInitial');fillSettings(initial.settings);if(initial.state.url)$('url').value=initial.state.url;updateState(initial.state);updateBilling(initial.billing);$('version').textContent=initial.version;if(!settings.projectId){$('settings-panel').hidden=false;$('settings-toggle').setAttribute('aria-expanded','true');}});}else{$('status').textContent='Windowsアプリ内で開いてください。';$('start').disabled=true;}
