'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const c=require('../src/core.cjs');const {parseMetadata,Vertex}=require('../src/services.cjs');
test('URLの正規化は動画だけを許可し外部ホスト・認証・不正IDを拒否',()=>{assert.equal(c.normalizeUrl('https://youtu.be/v64FpYCT6BA?t=90').url,'https://www.youtube.com/watch?v=v64FpYCT6BA');for(const url of ['https://youtube.com.evil.test/watch?v=v64FpYCT6BA','https://youtube.com/playlist?list=123','file:///watch?v=v64FpYCT6BA','https://user:pass@youtube.com/watch?v=v64FpYCT6BA','https://youtube.com/watch?v=abc'])assert.throws(()=>c.normalizeUrl(url));});
test('日付は日本時間、禁止文字を除去し空タイトルも安全化',()=>{assert.equal(c.safeFilename('A/B:"C"','2026-10-01T16:00:00Z'),'2026-10-02-A_B__C_.md');assert.equal(c.safeFilename('   ','2026-10-02T00:00:00Z'),'2026-10-02-動画.md');});
test('5時間の区間が全体を覆い文脈だけ重なる',()=>{const parts=c.makeIntervals(18000);assert.equal(parts.length,15);assert.equal(parts[0].inputStart,0);assert.equal(parts.at(-1).inputEnd,18000);for(let i=1;i<parts.length;i++){assert.equal(parts[i-1].end,parts[i].start);assert.equal(parts[i].inputStart,parts[i].start-5);}assert.equal(c.makeIntervals(8827).length,8);assert.throws(()=>c.makeIntervals(18001));});
test('YAML境界注入を文字列へエスケープし必要な見出しだけ描画',()=>{const md=c.renderMarkdown({title:'タイトル\n---\nsecret: x',url:'https://www.youtube.com/watch?v=v64FpYCT6BA',channel:'a: b',publishedAt:'2026-10-02T00:00:00Z'},'2026-10-02T00:00:00Z',['一','二','三','四','五'],[{heading:'話題',level:2,text:'本文'},{heading:'',level:2,text:'続き'}]);assert.equal(md.split('\n').filter(line=>line==='---').length,2);assert.match(md,/## 話題/);assert.throws(()=>c.validateTags(['一','一','三','四','五']));assert.throws(()=>c.validateTranscript({audio_accessible:true,complete:false,paragraphs:[{text:'本文'}]}));});
test('同名保存は既存ファイルを保持し一時ファイルを残さない',async()=>{const directory=await fs.mkdtemp(path.join(os.tmpdir(),'videomd-test-'));try{const paths=await Promise.all([c.saveUnique(directory,'file.md','one'),c.saveUnique(directory,'file.md','two')]);assert.notEqual(paths[0],paths[1]);assert.deepEqual((await Promise.all(paths.map(p=>fs.readFile(p,'utf8')))).sort(),['one','two']);assert.equal((await fs.readdir(directory)).length,2);}finally{await fs.rm(directory,{recursive:true,force:true});}});
test('動画メタデータが欠ければ補完せず失敗',()=>{const html='<meta content="PT17M38S" itemprop="duration"><meta itemprop="datePublished" content="2026-10-02T02:00:04-07:00">';const meta=parseMetadata(html,{title:'タイトル',author_name:'投稿者'},'url');assert.equal(meta.durationSeconds,1058);assert.throws(()=>parseMetadata('<meta itemprop="duration" content="PT1S">',{title:'title',author_name:'channel'},'url'));});
test('STOP以外でも返却使用量は記録し未完了を拒否',async()=>{let usage;const vertex=new Vertex({projectId:'test-project',model:c.MODELS[0]},async()=>'private-token',{onUsage:u=>{usage=u;},fetchImpl:async()=>({ok:true,json:async()=>({usageMetadata:{promptTokenCount:10},candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{}'}]}}]})})});await assert.rejects(vertex.generate([{text:'test'}],100),/中断/);assert.equal(usage.promptTokenCount,10);});
test('概算は推論出力を含み料金改定日を扱う',()=>{assert.equal(c.estimateUsd(c.MODELS[0],{promptTokenCount:1000000,candidatesTokenCount:1000000,thoughtsTokenCount:1000000},'2026-10-02'),8.25);assert.equal(c.estimateUsd(c.MODELS[0],{promptTokenCount:1000000},'2027-01-01'),1.5);});
test('複数話者と不明の発話順を保持し人物名・形式注入・欠落を拒否する',()=>{
 const data={audio_accessible:true,complete:true,paragraphs:[{speaker:'話者1',text:'質問です。'},{speaker:'話者2',text:'回答です。'},{speaker:'話者1',text:'追加質問です。'},{speaker:'話者不明',text:'重なった声です。'}]};
 const paragraphs=c.validateTranscript(data,{requireSpeakers:true});assert.deepEqual(paragraphs.map(p=>p.speaker),['話者1','話者2','話者1','話者不明']);
 for(const speaker of [undefined,'田中','話者0','話者100','話者1\n## 注入'])assert.throws(()=>c.validateTranscript({...data,paragraphs:[{speaker,text:'本文'}]},{requireSpeakers:true}),/話者/);
 assert.equal(c.validateTranscript({...data,paragraphs:[{text:'旧本文'}]})[0].speaker,undefined);
 const md=c.renderMarkdown({title:'対談',url:'url',channel:'投稿者',publishedAt:'2026-10-02'},'2026-10-02',['一','二','三','四','五'],paragraphs);
 assert.match(md,/\*\*話者1：\*\* 質問です。/);assert.match(md,/\*\*話者2：\*\* 回答です。/);assert.match(md,/\*\*話者不明：\*\*/);
 assert.ok(md.indexOf('質問です。')<md.indexOf('回答です。'));assert.ok(md.indexOf('回答です。')<md.indexOf('追加質問です。'));
});
test('並列区間の同番号を統合せず旧区間に話者を創作しない',()=>{
 const md=c.renderMarkdown({title:'長い対談',url:'url',channel:'投稿者',publishedAt:'2026-10-02'},'2026-10-02',['一','二','三','四','五'],[{text:'以前の本文',heading:''},{text:'最初の質問',speaker:'話者1',speakerScope:1},{text:'次の区間の別の声',speaker:'話者1',speakerScope:2}]);
 assert.match(md,/話者不明：\*\* 以前の本文/);assert.match(md,/話者1（区間1）/);assert.match(md,/話者1（区間2）/);assert.match(md,/同一人物とは限りません/);
});
test('動画音声のリクエストに話者交代と必須speakerを含める',async()=>{
 let request;const vertex=new Vertex({projectId:'test-project',model:c.MODELS[0]},async()=>'test-token',{fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({audio_accessible:true,complete:true,paragraphs:[{speaker:'話者1',text:'本文'}]})}]}}]})};}});
 await vertex.transcribe({url:'https://www.youtube.com/watch?v=v64FpYCT6BA'},c.makeIntervals(1200)[0]);const prompt=request.contents[0].parts.at(-1).text;assert.match(prompt,/話者が交代するたび/);assert.match(prompt,/各段落のspeakerは必須/);assert.match(prompt,/区別不能なら話者不明/);
});
test('本文中の根拠付き話者名を同区間で統一し、根拠欠落・矛盾なら番号に戻す',()=>{
 const result=c.validateTranscript({audio_accessible:true,complete:true,paragraphs:[{speaker:'話者1',text:'こんにちは、山田です。',speakerName:'山田',speakerNameEvidence:'山田です。'},{speaker:'話者2',text:'質問です。',speakerName:'田中',speakerNameEvidence:'田中です。'},{speaker:'話者1',text:'回答します。'}]},{requireSpeakers:true});
 assert.equal(result[0].speakerName,'山田');assert.equal(result[2].speakerName,'山田');assert.equal(result[1].speakerName,undefined);
 const md=c.renderMarkdown({title:'対談',url:'url',channel:'投稿者',publishedAt:'2026-10-03'},'2026-10-03',['一','二','三','四','五'],result);
 assert.match(md,/\*\*山田：\*\* 回答します。/);assert.match(md,/\*\*話者2：\*\* 質問です。/);
 const conflict=c.validateTranscript({audio_accessible:true,complete:true,paragraphs:[{speaker:'話者1',text:'山田です。',speakerName:'山田',speakerNameEvidence:'山田です。'},{speaker:'話者1',text:'田中です。',speakerName:'田中',speakerNameEvidence:'田中です。'}]},{requireSpeakers:true});assert.ok(conflict.every(p=>!p.speakerName));
 const unknown=c.validateTranscript({audio_accessible:true,complete:true,paragraphs:[{speaker:'話者不明',text:'山田です。',speakerName:'山田',speakerNameEvidence:'山田です。'}]});assert.equal(unknown[0].speakerName,undefined);
});
test('同名の複数話者は番号も添え、名前のMarkdown記号をエスケープ',()=>{
 const md=c.renderMarkdown({title:'対談',url:'url',channel:'投稿者',publishedAt:'2026-10-03'},'2026-10-03',['一','二','三','四','五'],[{speaker:'話者1',speakerName:'山田',speakerScope:1,text:'こんにちは。'},{speaker:'話者2',speakerName:'山田',speakerScope:1,text:'こんばんは。'},{speaker:'話者3',speakerName:'[名](https://example.test)',speakerScope:1,text:'本文'}]);
 assert.match(md,/山田（話者1）/);assert.match(md,/山田（話者2）/);assert.ok(md.includes('\\[名\\]\\(https://example.test\\)'));
});
