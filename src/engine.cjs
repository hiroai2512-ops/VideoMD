'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const {normalizeUrl,validateSettings,makeIntervals,validateTranscript,validateTags,renderMarkdown,safeFilename,saveUnique,estimateUsd}=require('./core.cjs');
const {createAuth,getMetadata,Vertex}=require('./services.cjs');
class Engine {
  constructor(store,{onState=()=>{},authFactory=createAuth,metadataLoader=getMetadata,vertexFactory=(...args)=>new Vertex(...args),pool=null}={}) {
    this.store=store;this.onState=onState;this.authFactory=authFactory;this.metadataLoader=metadataLoader;this.vertexFactory=vertexFactory;this.controller=null;
    this.pool=pool;this.persistence=Promise.resolve();
    this.state={phase:'idle',message:'YouTubeのURLを入力して開始してください。',busy:false,progress:0};
  }
  emit(update){Object.assign(this.state,update);this.onState({...this.state});}
  cancel(){this.controller?.abort();}
  persist(fn){const next=this.persistence.then(fn);this.persistence=next.catch(()=>{});return next;}
  request(fn,signal){return this.pool?this.pool.run(fn,signal):fn();}
  async restore() {
    const job=await this.store.read('job',null);
    if(!job)return;
    const exists=job.outputPath&&await fs.stat(job.outputPath).then(()=>true,()=>false);
    this.emit({url:job.metadata.url,metadata:job.metadata,canResume:!exists,outputPath:exists?job.outputPath:null,phase:exists?'complete':'idle',message:exists?'保存済みのMarkdownがあります。':'前回の処理を再開できます。URL・モデル・設定を確認してください。',progress:exists?1:job.chunks.filter(Boolean).length/job.intervals.length});
  }
  async run(input,{resume=false}={}) {
    if(this.controller)throw new Error('処理中です。完了またはキャンセルを待ってください。');
    const settings=validateSettings(input.settings);
    const {url}=normalizeUrl(input.url);
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify({url,...settings})).digest('hex');
    const controller=new AbortController();this.controller=controller;
    let job,saved;
    try{
      this.emit({phase:'auth',busy:true,message:'Googleアカウントを照合しています…',progress:0,outputPath:null,preview:null,error:null});
      saved=await this.store.read('job',null);
      const auth=await this.authFactory(settings);
      controller.signal.throwIfAborted();
      this.emit({account:auth.email,phase:'metadata',message:'動画情報を取得しています…'});
      if(resume && (!saved||saved.fingerprint!==fingerprint))throw new Error('再開するには前回と同じURL・モデル・設定を使ってください。');
      const previous=resume || (saved?.fingerprint===fingerprint && !saved.outputPath) ? saved : null;
      if(previous?.outputPath && await fs.stat(previous.outputPath).then(()=>true,()=>false)) {
        this.emit({phase:'complete',message:'保存済みの文字起こしです。',outputPath:previous.outputPath,metadata:previous.metadata});return previous.outputPath;
      }
      const metadata=previous?.metadata || await this.metadataLoader(url,controller.signal);
      if(!metadata.durationSeconds)throw new Error('動画の長さを取得できませんでした。');
      job=previous || {id:crypto.randomUUID(),fingerprint,startedAt:new Date().toISOString(),metadata,intervals:makeIntervals(metadata.durationSeconds),chunks:[],usage:[],model:settings.model,speakerLabels:true};
      await this.store.write('job',job);
      const vertex=this.vertexFactory(settings,auth.getToken,{onUsage:async usage=>this.persist(async()=>{
        const record={at:new Date().toISOString(),model:settings.model,usage,estimatedUsd:estimateUsd(settings.model,usage,new Date())};
        const ledger=await this.store.read('usage',[]);ledger.push(record);await this.store.write('usage',ledger);
        job.usage.push(record);await this.store.write('job',job);
        this.emit({estimatedUsd:job.usage.reduce((sum,r)=>sum+r.estimatedUsd,0)});
      }),onRetry:(attempt,status)=>{if(status===429||status===503)this.pool?.reduce();this.emit({message:`Google APIの応答待ち（${status}）。再試行 ${attempt}/2…`});}});
      this.emit({metadata,total:job.intervals.length,estimatedUsd:job.usage.reduce((sum,r)=>sum+r.estimatedUsd,0)});
      let cursor=0,failure;
      const completed=()=>job.chunks.filter(Boolean).length;
      const worker=async()=>{
        while(!failure && cursor<job.intervals.length){
          const index=cursor++;
          if(job.chunks[index])continue;
          try{
            controller.signal.throwIfAborted();
            this.emit({phase:'transcribing',message:`文字起こし中：完了 ${completed()}/${job.intervals.length} 区間`,progress:completed()/job.intervals.length});
            const result=await this.request(()=>vertex.transcribe(metadata,job.intervals[index],controller.signal),controller.signal);
            const paragraphs=validateTranscript(result,{requireSpeakers:job.speakerLabels===true}).map(p=>({...p,...(p.speaker?{speakerScope:index+1}:{})}));
            await this.persist(async()=>{job.chunks[index]=paragraphs;await this.store.write('job',job);});
            this.emit({progress:completed()/job.intervals.length,message:`文字起こし中：完了 ${completed()}/${job.intervals.length} 区間`});
          }catch(error){failure??=error;}
        }
      };
      await Promise.all(Array.from({length:this.pool?2:1},worker));
      if(failure)throw failure;
      controller.signal.throwIfAborted();
      const paragraphs=job.chunks.flat();
      if(!job.tags) {
        this.emit({phase:'tags',message:'全文から関連タグを作っています…',progress:0.95});
        job.tags=validateTags((await this.request(()=>vertex.tags(paragraphs,controller.signal),controller.signal)).tags);await this.store.write('job',job);
      }
      controller.signal.throwIfAborted();
      const markdown=renderMarkdown(metadata,job.startedAt,job.tags,paragraphs);
      this.emit({phase:'saving',message:'Markdownを保存しています…'});
      job.outputPath=await saveUnique(settings.outputDirectory,safeFilename(metadata.title,job.startedAt),markdown);
      await this.store.write('job',job);
      this.emit({phase:'complete',message:'Markdownを保存しました。',progress:1,outputPath:job.outputPath,preview:markdown,canResume:false});
      return job.outputPath;
    }catch(error){
      const cancelled=controller.signal.aborted;
      this.emit({phase:cancelled?'cancelled':'error',message:cancelled?'キャンセルしました。完了済み区間は保持しています。':error.message,error:cancelled?null:error.message,canResume:Boolean(job||saved)});
      if(!cancelled)throw error;
    }finally{this.controller=null;this.emit({busy:false});}
  }
}
module.exports={Engine};
