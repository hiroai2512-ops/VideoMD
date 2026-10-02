'use strict';
// Synthetic UI fixtures only: never connects to Google or accesses user files.
const previewSettings={projectId:'preview-project',expectedAccount:'preview@example.test',outputDirectory:'C:\\VideoMD',model:'gemini-3.8-flash'};
let previewListener=()=>{},previewCounter=0;
const previewItems=Array.from({length:4},(_,i)=>({id:`complete-${i}`,url:`https://www.youtube.com/watch?v=${String(i).padStart(11,'c')}`,phase:'complete',active:false,canResume:false,progress:1,metadata:{title:['学習ノートを読み返す習慣','仕事の振り返りを続ける方法','対談から考える事業設計','英語の講義を日本語で読む'][i],channel:'画面プレビュー用サンプル',publishedAt:'2026-10-03T00:00:00Z',durationSeconds:1200},outputPath:`C:\\VideoMD\\サンプル${i+1}.md`,message:'画面プレビュー・実ファイルなし',estimatedUsd:0}));
function previewState(){const activeCount=previewItems.filter(i=>i.active).length,pendingCount=previewItems.filter(i=>i.phase==='queued').length;return {items:previewItems,activeCount,pendingCount,busy:activeCount+pendingCount>0,availableSlots:2-activeCount,availablePending:100-pendingCount,maxPending:100,effectiveMaxActive:2,apiLimit:2,message:'画面プレビュー。API処理は実行しません。'};}
function previewPump(){while(previewItems.filter(i=>i.active).length<2){const item=previewItems.find(i=>i.phase==='queued');if(!item)break;Object.assign(item,{active:true,phase:'transcribing',progress:0.3,metadata:{title:`文字起こしサンプル ${item.id}`,channel:'画面プレビュー用サンプル',publishedAt:'2026-10-03T00:00:00Z',durationSeconds:2500},message:'画面プレビュー。API実行なし。'});}previewListener(previewState());}
function previewOpen(id,type){const item=previewItems.find(i=>i.id===id);document.getElementById('settings-message').textContent=`プレビュー：${item?.metadata?.title||id}の${type}を開く操作を確認（実ファイルなし）`;return {ok:true};}
window.videoMD={
 getInitial:async()=>({ok:true,value:{settings:previewSettings,state:previewState(),billing:{connected:false,message:'画面プレビュー。実料金ではありません。'},version:'0.1.0'}}),
 saveSettings:async()=>({ok:true,value:previewSettings}),
 start:async input=>{if(input.resume){const item=previewItems.find(i=>i.id===input.id);if(item)item.phase='queued';}else{if((input.urls||[]).length>previewState().availablePending+previewState().availableSlots)return {ok:false,error:'待機場の上限を超えています。'};for(const url of input.urls||[])previewItems.push({id:String(++previewCounter),url,phase:'queued',active:false,canResume:false,progress:0,message:'画面プレビュー。API実行なし。'});}previewPump();return {ok:true};},
 cancel:async id=>{const item=previewItems.find(i=>i.id===id);if(item)Object.assign(item,{active:false,phase:'cancelled',canResume:true,message:'プレビュー：取消'});previewPump();return {ok:true};},
 moveQueued:async(id,direction)=>{const waiting=previewItems.filter(i=>i.phase==='queued');const index=waiting.findIndex(i=>i.id===id);const other=waiting[index+direction];if(other){const a=previewItems.findIndex(i=>i.id===id),b=previewItems.indexOf(other);[previewItems[a],previewItems[b]]=[previewItems[b],previewItems[a]];}previewListener(previewState());return {ok:true};},
 openOutput:async id=>previewOpen(id,'Markdown'),openFolder:async id=>previewOpen(id,'保存フォルダ'),
 onState:fn=>{previewListener=fn;},onBilling:()=>{},
};
const previewControls=document.createElement('div');previewControls.className='actions';previewControls.style.padding='8px 24px';
const previewLabel=document.createElement('span');previewLabel.textContent='画面プレビュー（架空データ・API実行なし）';
const previewComplete=document.createElement('button');previewComplete.textContent='プレビュー：1本完了';previewComplete.addEventListener('click',()=>{const item=previewItems.find(i=>i.active);if(item)Object.assign(item,{active:false,phase:'complete',progress:1,outputPath:'C:\\VideoMD\\プレビュー.md',message:'プレビュー：完了'});previewPump();});
previewControls.append(previewLabel,previewComplete);document.body.append(previewControls);
