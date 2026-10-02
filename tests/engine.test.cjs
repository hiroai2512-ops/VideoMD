'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {Engine}=require('../src/engine.cjs');const {Store}=require('../src/store.cjs');
test('失敗した長動画は完了区間を保持して再開しAPIへ再送しない',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'videomd-engine-'));const store=new Store(path.join(root,'state'));let calls=0,fail=true;
  const settings={projectId:'test-project',expectedAccount:'test@example.test',model:'gemini-3.8-flash',outputDirectory:path.join(root,'output')};
  const engine=new Engine(store,{authFactory:async()=>({email:settings.expectedAccount,getToken:async()=>'secret'}),metadataLoader:async url=>({url,title:'長動画',channel:'投稿者',publishedAt:'2026-10-02T00:00:00Z',durationSeconds:1300}),vertexFactory:()=>({transcribe:async(_meta,interval)=>{calls++;if(fail&&interval.start>0)throw new Error('temporary');return {audio_accessible:true,complete:true,paragraphs:[{text:`区間${interval.start}`,heading:'',level:2}]};},tags:async()=>({tags:['一','二','三','四','五']})})});
  try{await assert.rejects(engine.run({url:'https://youtu.be/v64FpYCT6BA',settings}),/temporary/);assert.equal((await store.read('job')).chunks.length,1);fail=false;const output=await engine.run({url:'https://youtu.be/v64FpYCT6BA',settings},{resume:true});assert.equal(calls,3);const md=await fs.readFile(output,'utf8');assert.match(md,/区間0/);assert.match(md,/区間1200/);assert.equal(engine.state.phase,'complete');assert.equal(engine.state.busy,false);await assert.rejects(engine.run({url:'https://youtu.be/aaaaaaaaaaa',settings},{resume:true}),/同じURL/);}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('認証不一致なら動画もAIも取得しない',async()=>{let metadataCalled=false;const engine=new Engine({read:async()=>null},{authFactory:async()=>{throw new Error('認証不一致');},metadataLoader:()=>{metadataCalled=true;}});await assert.rejects(engine.run({url:'https://youtu.be/v64FpYCT6BA',settings:{projectId:'test-project',expectedAccount:'test@example.test',outputDirectory:os.tmpdir()}}),/認証不一致/);assert.equal(metadataCalled,false);});
test('VMD-R1: 再起動と再開時の認証失敗でもURLと再開導線を保持',async()=>{
  const saved={metadata:{url:'https://www.youtube.com/watch?v=v64FpYCT6BA',title:'動画'},intervals:[{start:0,end:1200},{start:1200,end:1300}],chunks:[[{text:'保存済み'}]]};
  const engine=new Engine({read:async()=>saved},{authFactory:async()=>{throw new Error('temporary auth');}});
  await engine.restore();assert.equal(engine.state.canResume,true);assert.equal(engine.state.url,saved.metadata.url);assert.equal(engine.state.progress,0.5);
  await assert.rejects(engine.run({url:saved.metadata.url,settings:{projectId:'test-project',expectedAccount:'test@example.test',outputDirectory:os.tmpdir()}},{resume:true}),/temporary auth/);
  assert.equal(engine.state.canResume,true);assert.equal(engine.state.url,saved.metadata.url);
});
