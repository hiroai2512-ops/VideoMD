'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {findAdc}=require('../src/services.cjs');
test('専用ADCは共有環境変数より優先、明示指定は専用より優先する',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'videomd-auth-'));
  const previous={APPDATA:process.env.APPDATA,GOOGLE_APPLICATION_CREDENTIALS:process.env.GOOGLE_APPLICATION_CREDENTIALS};
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(root,{recursive:true,force:true});});
  const dedicated=path.join(root,'VideoMD','gcloud','application_default_credentials.json');const explicit=path.join(root,'explicit.json');const shared=path.join(root,'shared.json');
  fs.mkdirSync(path.dirname(dedicated),{recursive:true});for(const file of [dedicated,explicit,shared])fs.writeFileSync(file,'{}');
  process.env.APPDATA=root;process.env.GOOGLE_APPLICATION_CREDENTIALS=shared;
  assert.equal(findAdc(),dedicated);assert.equal(findAdc(explicit),explicit);
  fs.unlinkSync(dedicated);assert.equal(findAdc(),shared);
  assert.throws(()=>findAdc(path.join(root,'missing.json')),/ありません/);
});
