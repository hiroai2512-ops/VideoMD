'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Store}=require('./store.cjs');
const {Engine}=require('./engine.cjs');
const {normalizeUrl,validateSettings}=require('./core.cjs');

class WorkPool {
  constructor({limit=2,onChange=()=>{}}={}) {
    if(!Number.isInteger(limit)||limit<1)throw new Error('API同時実行数が不正です。');
    this.limit=limit;this.onChange=onChange;this.active=0;this.waiting=[];
  }
  reduce(){if(this.limit!==1){this.limit=1;this.onChange(this.limit);}return this.limit;}
  run(fn,signal) {
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(signal.reason||new DOMException('Aborted','AbortError'));return;}
      const entry={fn,signal,resolve,reject};
      entry.abort=()=>{const index=this.waiting.indexOf(entry);if(index>=0){this.waiting.splice(index,1);reject(signal.reason||new DOMException('Aborted','AbortError'));}};
      signal?.addEventListener('abort',entry.abort,{once:true});
      this.waiting.push(entry);this._drain();
    });
  }
  _drain() {
    while(this.active<this.limit&&this.waiting.length){
      const entry=this.waiting.shift();entry.signal?.removeEventListener('abort',entry.abort);
      if(entry.signal?.aborted){entry.reject(entry.signal.reason||new DOMException('Aborted','AbortError'));continue;}
      this.active++;
      Promise.resolve().then(()=>{entry.signal?.throwIfAborted();return entry.fn();}).then(entry.resolve,entry.reject).finally(()=>{this.active--;this._drain();});
    }
  }
}

const resumable=new Set(['queued','paused','cancelled','error']);
const phases=new Set(['queued','running','paused','cancelled','error','complete','auth','metadata','transcribing','tags','saving','idle']);
const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
class Queue {
  constructor(store,{onState=()=>{},engineFactory=(s,o)=>new Engine(s,o),pool=new WorkPool(),maxActive=2,maxPending=100}={}) {
    if(!Number.isInteger(maxActive)||maxActive<1||!Number.isInteger(maxPending)||maxPending<0)throw new Error('キュー上限が不正です。');
    this.store=store;this.onState=onState;this.engineFactory=engineFactory;this.pool=pool;this.maxActive=maxActive;this.maxPending=maxPending;
    this.items=[];this.engines=new Map();this.active=new Map();this.serial=Promise.resolve();this.persistenceError=null;
    const previous=pool.onChange;pool.onChange=(...args)=>{previous(...args);this._emit();};
  }
  get state(){
    const activeCount=this.active.size;const queued=this.items.filter(i=>i.phase==='queued').length;
    const effectiveMaxActive=Math.min(this.maxActive,this.pool.limit);
    const free=Math.max(0,effectiveMaxActive-activeCount);
    const pendingCount=Math.max(0,queued-free);
    const items=this.items.map(i=>this.getItem(i.id));
    return {busy:activeCount>0||queued>0,items,activeCount,pendingCount,availableSlots:Math.max(0,free-queued),availablePending:Math.max(0,this.maxPending-pendingCount),apiLimit:this.pool.limit,maxActive:this.maxActive,effectiveMaxActive,maxPending:this.maxPending,message:this.persistenceError|| (activeCount?`${activeCount}件を処理中です。`:queued?'処理を開始しています。':'動画を追加または再開してください。'),phase:this.persistenceError?'error':activeCount?'running':queued?'queued':'idle',progress:items.length?items.reduce((s,i)=>s+(i.progress||0),0)/items.length:0};
  }
  getItem(id){const item=this.items.find(i=>i.id===id);if(!item)return null;const {settings,resume,cancelRequested,...info}=item;return structuredClone({...info,active:this.active.has(id),needsSettings:!settings,canResume:!this.active.has(id)&&resumable.has(item.phase)&&item.phase!=='queued'});}
  _emit(){this.onState(this.state);}
  _serialize(fn){const next=this.serial.then(fn);this.serial=next.catch(()=>{});return next;}
  _prune(){const completed=this.items.filter(i=>i.phase==='complete');const discard=new Set(completed.slice(0,Math.max(0,completed.length-100)).map(i=>i.id));this.items=this.items.filter(i=>!discard.has(i.id));for(const id of discard)this.engines.delete(id);}
  async _save(){this._prune();await this.store.write('queue',{version:1,items:this.items});}
  _background(fn){this._serialize(fn).catch(error=>{this.persistenceError=error.message;this._emit();});}
  _engine(item){
    if(this.engines.has(item.id))return this.engines.get(item.id);
    const engine=this.engineFactory(new Store(path.join(this.store.root,'jobs',item.id)),{pool:this.pool,onState:update=>{
      // Engine state has no authority over the saved URL or settings snapshot.
      for(const key of ['phase','message','progress','metadata','outputPath','estimatedUsd'])if(Object.hasOwn(update,key))item[key]=structuredClone(update[key]);
      this._emit();if(!this.restoring)this._background(()=>this._save());
    }});
    this.engines.set(item.id,engine);return engine;
  }
  async restore(){return this._serialize(async()=>{
    if(this.active.size)throw new Error('処理中はキューを復元できません。');
    this.restoring=true;
    try{
    const saved=await this.store.read('queue',null);
    if(saved){
      if(saved.version!==1||!Array.isArray(saved.items))throw new Error('保存済みキューの形式が不正です。データは保持されています。');
      const ids=new Set();
      this.items=saved.items.map(raw=>{
        if(!raw||!idPattern.test(raw.id)||ids.has(raw.id)||!phases.has(raw.phase)||normalizeUrl(raw.url).url!==raw.url)throw new Error('保存済みキューの項目が不正です。データは保持されています。');
        ids.add(raw.id);const settings=raw.settings===null?null:validateSettings(raw.settings);
        return {...raw,settings};
      });
    }else{
      const legacy=await this.store.read('job',null);
      if(legacy){
        const url=normalizeUrl(legacy.metadata?.url).url;const id=crypto.randomUUID();
        const rawSettings=await this.store.read('settings',null);let settings=null;
        if(rawSettings){try{settings=validateSettings(rawSettings);}catch{ /* Preserve legacy data even when settings need repair. */ }}
        const jobStore=new Store(path.join(this.store.root,'jobs',id));await jobStore.write('job',legacy);
        const usage=await this.store.read('usage',null);if(usage)await jobStore.write('usage',usage);
        this.items=[{id,url,settings,phase:'paused',message:settings?'前回の処理を再開できます。':'旧ジョブの設定を確認できません。元データを保持しています。',progress:0,metadata:legacy.metadata,outputPath:legacy.outputPath||null,estimatedUsd:0,createdAt:new Date().toISOString()}];
      }
    }
    for(const item of this.items){
      const previousPhase=item.phase;const previousMessage=item.message;
      const engine=this._engine(item);await engine.restore();
      if(item.phase!=='complete'){
        item.phase=['cancelled','error'].includes(previousPhase)?previousPhase:'paused';
        item.message=item.settings?(['cancelled','error'].includes(previousPhase)?previousMessage:'再開を押すまで処理を開始しません。'):'保存済み設定を確認できません。元データを保持しています。';
      }
    }
    await this._save();this._emit();return this.state;
    }finally{this.restoring=false;}
  });}
  async enqueue(urls,settings){
    if(!Array.isArray(urls)||!urls.length)throw new Error('動画URLを1件以上入力してください。');
    const normalized=urls.map(u=>normalizeUrl(u).url);const snapshot=validateSettings(settings);
    const result=await this._serialize(async()=>{
      if(this.persistenceError)throw new Error(this.persistenceError);
      const unfinished=new Set(this.items.filter(i=>i.phase!=='complete').map(i=>i.url));
      if(new Set(normalized).size!==normalized.length||normalized.some(u=>unfinished.has(u)))throw new Error('未完了の同じ動画URLが含まれています。');
      const queued=this.items.filter(i=>i.phase==='queued').length;
      if(queued+normalized.length>this.maxPending+Math.max(0,Math.min(this.maxActive,this.pool.limit)-this.active.size))throw new Error('待機場の上限を超えています。');
      const added=normalized.map(url=>({id:crypto.randomUUID(),url,settings:structuredClone(snapshot),phase:'queued',message:'処理を待っています。',progress:0,metadata:null,outputPath:null,estimatedUsd:0,createdAt:new Date().toISOString()}));
      const previous=this.items;this.items=[...previous,...added];try{await this._save();}catch(error){this.items=previous;throw error;}
      this._emit();return added.map(i=>this.getItem(i.id));
    });
    this._background(()=>this._pump());return result;
  }
  async resume(id,settingsOverride){
    await this._serialize(async()=>{
      if(this.persistenceError)throw new Error(this.persistenceError);
      const item=this.items.find(i=>i.id===id);
      if(!item||!resumable.has(item.phase)||this.active.has(id))throw new Error('この動画は再開できません。');
      let snapshot=item.settings||validateSettings(settingsOverride||{});
      // Repair credentials without changing a saved job's project, billing or model.
      if(item.settings && settingsOverride) {
        const current=validateSettings(settingsOverride);
        if(current.projectId===snapshot.projectId && current.expectedAccount===snapshot.expectedAccount)
          snapshot={...snapshot,adcFile:current.adcFile};
      }
      if(item.phase==='queued')throw new Error('この動画はすでに待機中です。');
      const queued=this.items.filter(i=>i.phase==='queued').length;
      if(queued>=this.maxPending+Math.max(0,Math.min(this.maxActive,this.pool.limit)-this.active.size))throw new Error('待機場の上限を超えています。');
      const previous={...item};item.settings=snapshot;item.phase='queued';item.resume=true;item.message='再開を待っています。';
      try{await this._save();}catch(error){Object.assign(item,previous);throw error;}this._emit();
    });this._background(()=>this._pump());return this.getItem(id);
  }
  async cancel(id){
    return this._serialize(async()=>{
      const targets=id?this.items.filter(i=>i.id===id):this.items;
      if(id&&!targets.length)throw new Error('動画が見つかりません。');
      for(const item of targets){
        if(this.active.has(item.id)){item.cancelRequested=true;this.engines.get(item.id)?.cancel();}
        else if(item.phase==='queued'){item.phase='cancelled';item.message='キャンセルしました。再開できます。';}
      }
      await this._save();this._emit();return this.state;
    });
  }
  async moveQueued(id,direction){return this._serialize(async()=>{
    if(this.persistenceError)throw new Error(this.persistenceError);
    if(![-1,1].includes(direction))throw new Error('待機順の移動方向が不正です。');
    const waiting=this.items.filter(item=>item.phase==='queued'&&!this.active.has(item.id));
    const index=waiting.findIndex(item=>item.id===id);
    if(index<0)throw new Error('順番待ちの動画だけ移動できます。');
    const target=waiting[index+direction];if(!target)return this.state;
    const previous=this.items;this.items=[...previous];
    const from=this.items.indexOf(waiting[index]),to=this.items.indexOf(target);
    [this.items[from],this.items[to]]=[this.items[to],this.items[from]];
    try{await this._save();}catch(error){this.items=previous;throw error;}
    this._emit();return this.state;
  });}
  async _pump(){
    if(this.persistenceError)return;
    while(this.active.size<Math.min(this.maxActive,this.pool.limit)){
      const item=this.items.find(i=>i.phase==='queued');if(!item)break;
      const saved=await new Store(path.join(this.store.root,'jobs',item.id)).read('job',null);
      item.phase='running';item.message='処理を開始しています。';const engine=this._engine(item);this.active.set(item.id,engine);
      try{await this._save();}catch(error){this.active.delete(item.id);item.phase='paused';throw error;}this._emit();
      const resume=Boolean(item.resume&&saved);delete item.resume;
      Promise.resolve().then(()=>engine.run({url:item.url,settings:structuredClone(item.settings)},{resume})).then(output=>{
        if(output)item.outputPath=output;
        if(item.cancelRequested)item.phase='cancelled';
        else if(item.phase==='running')item.phase=output?'complete':'error';
      },error=>{item.phase=item.cancelRequested?'cancelled':'error';item.message=error.message;}).finally(()=>{
        this._background(async()=>{
          this.active.delete(item.id);delete item.cancelRequested;
          await this._save();this._emit();await this._pump();
        });
      });
    }
  }
}
module.exports={Queue,WorkPool};
