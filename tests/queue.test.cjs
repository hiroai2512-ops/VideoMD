'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {Queue,WorkPool}=require('../src/queue.cjs');const {Store}=require('../src/store.cjs');
const url=n=>`https://youtu.be/${String(n).padStart(11,'a')}`;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('状態待機がタイムアウトしました。');}
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'videomd-queue-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new Store(root);const settings={projectId:'test-project',expectedAccount:'test@example.test',outputDirectory:root,access_token:'secret'};
  const starts=[];const controls=new Map();
  const engineFactory=(jobStore,{onState,pool})=>({state:{},restore:async()=>{},cancel(){controls.get(jobStore.root)?.resolve();},run(input,opts){starts.push({input,opts,jobStore,pool});onState({phase:'transcribing',progress:0.1});return new Promise((resolve,reject)=>{controls.set(jobStore.root,{resolve:()=>{onState({phase:'cancelled'});resolve();},complete:()=>{onState({phase:'complete',outputPath:path.join(root,'out.md'),progress:1});resolve(path.join(root,'out.md'));},reject});});}});
  return {root,store,settings,starts,controls,engineFactory,queue:new Queue(store,{engineFactory,...options})};
}
test('受付は原子的でURL正規化、秘密値を除いた設定snapshotを保存する',async t=>{
  const f=await fixture(t);await assert.rejects(f.queue.enqueue([url(1),'invalid'],f.settings));assert.equal(f.queue.state.items.length,0);
  await assert.rejects(f.queue.enqueue([url(1),url(1)],f.settings));
  const added=await f.queue.enqueue([url(1)],f.settings);f.settings.model='changed';
  await until(()=>f.starts.length===1);assert.equal(f.starts[0].input.settings.model,'gemini-3.8-flash');
  await assert.rejects(f.queue.enqueue([url(1)],f.settings));
  const saved=await f.store.read('queue');assert.equal(saved.items[0].settings.access_token,undefined);assert.equal(added[0].settings,undefined);
  await f.queue.cancel();await until(()=>!f.queue.state.busy);await f.queue.serial;
});
test('2件起動、20件待機の上限と1件失敗時の独立した進行',async t=>{
  const f=await fixture(t,{maxPending:20});await f.queue.enqueue(Array.from({length:22},(_,i)=>url(i)),f.settings);
  await until(()=>f.starts.length===2);assert.equal(f.queue.state.activeCount,2);assert.equal(f.queue.state.pendingCount,20);
  await assert.rejects(f.queue.enqueue([url(30)],f.settings),/上限/);assert.equal(f.queue.state.items.length,22);
  f.controls.get(f.starts[0].jobStore.root).reject(new Error('one failure'));
  await until(()=>f.starts.length===3);assert.equal(f.queue.state.items[0].phase,'error');assert.equal(f.queue.state.activeCount,2);
  await f.queue.cancel();await until(()=>!f.queue.state.busy);assert.equal(f.starts.length,3);await f.queue.serial;
});
test('個別キャンセルは他ジョブを止めず待機ジョブをAPIなしで再開できる',async t=>{
  const f=await fixture(t);const items=await f.queue.enqueue([url(1),url(2),url(3)],f.settings);await until(()=>f.starts.length===2);
  await f.queue.cancel(items[2].id);assert.equal(f.queue.getItem(items[2].id).phase,'cancelled');assert.equal(f.starts.length,2);
  await f.queue.resume(items[2].id);f.controls.get(f.starts[0].jobStore.root).complete();await until(()=>f.starts.length===3);
  assert.equal(f.starts[2].opts.resume,false);assert.equal(f.queue.getItem(items[1].id).phase,'transcribing');
  await f.queue.cancel();await until(()=>!f.queue.state.busy);await f.queue.serial;
});
test('再起動は待機と処理中をpausedで復元し自動実行しない',async t=>{
  const f=await fixture(t);await f.queue.enqueue([url(1),url(2),url(3)],f.settings);await until(()=>f.starts.length===2);await f.queue.serial;
  let count=0;const restored=new Queue(f.store,{engineFactory:()=>({restore:async()=>{},run:async()=>{count++;}})});await restored.restore();
  assert.equal(count,0);assert.ok(restored.state.items.every(i=>i.phase==='paused'));assert.equal(restored.state.busy,false);
  await f.queue.cancel();await until(()=>!f.queue.state.busy);await f.queue.serial;
});
test('旧ジョブは非破壊コピー、設定がない場合は設定補完まで実行しない',async t=>{
  const f=await fixture(t);const job={metadata:{url:url(1)},chunks:[],intervals:[{}]};await f.store.write('job',job);await f.queue.restore();
  const item=f.queue.state.items[0];assert.equal(item.needsSettings,true);assert.deepEqual(await f.store.read('job'),job);
  assert.deepEqual(await new Store(path.join(f.root,'jobs',item.id)).read('job'),job);await assert.rejects(f.queue.resume(item.id));assert.equal(f.starts.length,0);
  await f.queue.resume(item.id,f.settings);await until(()=>f.starts.length===1);assert.equal(f.starts[0].opts.resume,true);
  await f.queue.cancel();await until(()=>!f.queue.state.busy);await f.queue.serial;
});
test('破損したキューを消さず復元を停止する',async t=>{
  const f=await fixture(t);const corrupt={version:1,items:[{id:'../outside',url:url(1),phase:'queued'}]};await f.store.write('queue',corrupt);
  await assert.rejects(f.queue.restore(),/不正/);assert.deepEqual(await f.store.read('queue'),corrupt);assert.equal(f.starts.length,0);
});
test('共有poolはFIFO、待機abort、縮退後はセッション中1並列を維持',async()=>{
  const changed=[];const pool=new WorkPool({onChange:n=>changed.push(n)});const release=[];const order=[];let active=0,maximum=0;
  const work=n=>pool.run(()=>new Promise(resolve=>{order.push(n);active++;maximum=Math.max(maximum,active);release[n]=()=>{active--;resolve(n);};}));
  const first=work(0),second=work(1);const abort=new AbortController();const rejected=pool.run(()=>assert.fail('aborted task ran'),abort.signal);const rejection=assert.rejects(rejected);abort.abort();
  const third=work(2),fourth=work(3);await tick();assert.deepEqual(order,[0,1]);pool.reduce();pool.reduce();assert.deepEqual(changed,[1]);
  release[0]();await first;await tick();assert.deepEqual(order,[0,1]);release[1]();await second;await until(()=>release[2]);assert.deepEqual(order,[0,1,2]);
  release[2]();await third;await until(()=>release[3]);release[3]();await fourth;await rejection;assert.equal(maximum,2);assert.equal(pool.limit,1);
});
test('poolの実行失敗は次の予約を阻害しない',async()=>{
  const pool=new WorkPool({limit:1});await assert.rejects(pool.run(()=>{throw new Error('bad');}),/bad/);assert.equal(await pool.run(()=>42),42);
});
test('同時受付は保存を直列化して容量を守り、失敗した保存は受付を戻す',async t=>{
  const f=await fixture(t,{maxActive:1,maxPending:1});
  const results=await Promise.allSettled([f.queue.enqueue([url(1),url(2)],f.settings),f.queue.enqueue([url(3)],f.settings)]);
  assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected']);await until(()=>f.starts.length===1);
  await f.queue.cancel();await until(()=>!f.queue.state.busy);await f.queue.serial;
  const failing=new Queue({root:f.root,write:async()=>{throw new Error('disk full');}},{engineFactory:f.engineFactory});
  await assert.rejects(failing.enqueue([url(4)],f.settings),/disk full/);assert.equal(failing.state.items.length,0);
});
test('完了履歴は100件までで未完了履歴を保持する',async t=>{
  const f=await fixture(t);const crypto=require('node:crypto');
  const items=Array.from({length:101},(_,i)=>({id:crypto.randomUUID(),url:`https://www.youtube.com/watch?v=${String(i).padStart(11,'a')}`,settings:f.settings,phase:'complete',progress:1}));
  items.unshift({id:crypto.randomUUID(),url:'https://www.youtube.com/watch?v=bbbbbbbbbbb',settings:f.settings,phase:'cancelled',progress:0});
  await f.store.write('queue',{version:1,items});await f.queue.restore();
  assert.equal(f.queue.state.items.filter(i=>i.phase==='complete').length,100);assert.equal(f.queue.state.items[0].phase,'cancelled');
});
test('ジョブ復元の失敗ではキューを上書きせず停止する',async t=>{
  const f=await fixture(t);const crypto=require('node:crypto');const saved={version:1,items:[{id:crypto.randomUUID(),url:'https://www.youtube.com/watch?v=aaaaaaaaaaa',settings:f.settings,phase:'paused',progress:0}]};await f.store.write('queue',saved);
  const queue=new Queue(f.store,{engineFactory:(_,{onState})=>({restore:async()=>{onState({progress:0.5});throw new Error('corrupt job');}})});
  await assert.rejects(queue.restore(),/corrupt job/);await queue.serial;assert.deepEqual(await f.store.read('queue'),saved);
});
test('実Engineを2動画接続してもAPI合計は2件、別々の本文と台帳を保存する',async t=>{
  const f=await fixture(t);const {Engine}=require('../src/engine.cjs');let active=0,peak=0;
  const queue=new Queue(f.store,{engineFactory:(store,options)=>new Engine(store,{...options,authFactory:async()=>({email:f.settings.expectedAccount,getToken:async()=>''}),metadataLoader:async url=>({url,title:url.slice(-11),channel:'投稿者',publishedAt:'2026-10-02T00:00:00Z',durationSeconds:2500}),vertexFactory:(_s,_a,{onUsage})=>({transcribe:async(meta,interval)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,interval.start===0?10:2));await onUsage({promptTokenCount:10,candidatesTokenCount:20});active--;return {audio_accessible:true,complete:true,paragraphs:[{speaker:'話者1',text:`${meta.title}:${interval.start}`,heading:'',level:2}]};},tags:async()=>({tags:['一','二','三','四','五']})})})});
  await queue.enqueue([url(1),url(2)],f.settings);await until(()=>queue.state.items.every(i=>i.phase==='complete')&&!queue.state.busy);await queue.serial;
  assert.equal(peak,2);
  for(const item of queue.state.items){const md=await fs.readFile(item.outputPath,'utf8');const id=item.url.slice(-11);assert.ok(md.indexOf(`${id}:0`)<md.indexOf(`${id}:1200`));assert.ok(md.indexOf(`${id}:1200`)<md.indexOf(`${id}:2400`));const store=new Store(path.join(f.root,'jobs',item.id));assert.equal((await store.read('usage',[])).length,3);assert.equal((await store.read('job')).chunks.length,3);}
});
test('100本の待機場は実行2本と別枠で上限を守り空いた枠を先頭から補充',async t=>{
 const f=await fixture(t);const added=await f.queue.enqueue(Array.from({length:102},(_,i)=>url(i)),f.settings);
 await until(()=>f.starts.length===2);assert.equal(f.queue.state.pendingCount,100);assert.equal(f.queue.state.availablePending,0);assert.equal(f.queue.state.availableSlots,0);
 await assert.rejects(f.queue.enqueue([url(200)],f.settings),/上限/);assert.equal(f.queue.state.items.length,102);
 f.controls.get(f.starts[1].jobStore.root).complete();await until(()=>f.starts.length===3);
 assert.equal(f.starts[2].input.url,added[2].url);assert.equal(f.queue.state.activeCount,2);assert.equal(f.queue.state.availablePending,1);
 await f.queue.cancel();await until(()=>!f.queue.state.busy);await f.queue.serial;
});
test('上下操作の待機順を保存して先頭から実行、実行中と不正方向は移動不可',async t=>{
 const f=await fixture(t);const items=await f.queue.enqueue([url(1),url(2),url(3),url(4),url(5)],f.settings);await until(()=>f.starts.length===2);
 await f.queue.moveQueued(items[4].id,-1);await f.queue.moveQueued(items[4].id,-1);
 const order=f.queue.state.items.filter(i=>i.phase==='queued').map(i=>i.id);assert.deepEqual(order,[items[4].id,items[2].id,items[3].id]);
 assert.deepEqual((await f.store.read('queue')).items.filter(i=>i.phase==='queued').map(i=>i.id),order);
 await assert.rejects(f.queue.moveQueued(items[0].id,1),/順番待ち/);await assert.rejects(f.queue.moveQueued(items[4].id,2),/方向/);
 f.controls.get(f.starts[0].jobStore.root).complete();await until(()=>f.starts.length===3);assert.equal(f.starts[2].input.url,items[4].url);
 await f.queue.cancel();await until(()=>!f.queue.state.busy);await f.queue.serial;
});
test('混雑で1動画へ縮退すると既存2本を保持し1本ずつ自動補充',async t=>{
 const f=await fixture(t);const items=await f.queue.enqueue([url(1),url(2),url(3),url(4)],f.settings);await until(()=>f.starts.length===2);
 f.queue.pool.reduce();assert.equal(f.queue.state.effectiveMaxActive,1);assert.equal(f.queue.state.apiLimit,1);
 f.controls.get(f.starts[0].jobStore.root).complete();await until(()=>f.queue.state.activeCount===1);assert.equal(f.starts.length,2);
 f.controls.get(f.starts[1].jobStore.root).complete();await until(()=>f.starts.length===3);assert.equal(f.queue.state.activeCount,1);assert.equal(f.starts[2].input.url,items[2].url);
 f.controls.get(f.starts[2].jobStore.root).complete();await until(()=>f.starts.length===4);assert.equal(f.starts[3].input.url,items[3].url);assert.equal(f.queue.state.activeCount,1);
 await f.queue.cancel();await until(()=>!f.queue.state.busy);await f.queue.serial;
});
test('移動の保存失敗時は元の順番を保つ',async t=>{
 const f=await fixture(t);const items=await f.queue.enqueue([url(1),url(2),url(3),url(4)],f.settings);await until(()=>f.starts.length===2);await f.queue.serial;
 const original=f.store.write;f.store.write=async()=>{throw new Error('disk full');};await assert.rejects(f.queue.moveQueued(items[3].id,-1),/disk full/);f.store.write=original;
 assert.deepEqual(f.queue.state.items.filter(i=>i.phase==='queued').map(i=>i.id),[items[2].id,items[3].id]);await f.queue.cancel();await until(()=>!f.queue.state.busy);await f.queue.serial;
});
