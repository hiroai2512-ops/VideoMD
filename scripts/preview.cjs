'use strict';
// Development-only layout preview. No cloud calls, credentials or filesystem IPC.
const http=require('node:http');const fs=require('node:fs/promises');const path=require('node:path');
const files={'/':['index.html','text/html'],'/renderer.js':['renderer.js','text/javascript'],'/style.css':['style.css','text/css']};
http.createServer(async(req,res)=>{
  if(req.url==='/preview-bridge.js'){res.setHeader('Content-Type','text/javascript');res.end(`
const previewSettings={projectId:'preview-project',expectedAccount:'preview@example.test',outputDirectory:'C:\\\\VideoMD',model:'gemini-3.8-flash'};
let previewState={items:[],activeCount:0,pendingCount:0,availableSlots:2,availablePending:20,apiLimit:2,busy:false,message:'画面プレビュー。API処理は実行しません。'},previewListener=()=>{};
window.videoMD={getInitial:async()=>({ok:true,value:{settings:previewSettings,state:previewState,billing:{connected:false},version:'0.1.0'}}),saveSettings:async()=>({ok:true,value:previewSettings}),start:async input=>{for(const url of input.urls||[])previewState.items.push({id:String(previewState.items.length),url,phase:'paused',canResume:false,progress:0,message:'画面プレビュー。API実行なし。'});previewState.availablePending=20;previewListener(previewState);return {ok:true};},onState:fn=>{previewListener=fn;},onBilling:()=>{}};
`);return;}
  const file=files[req.url];if(!file){res.writeHead(404);res.end();return;}
  try{let content=await fs.readFile(path.join(__dirname,'..','src','ui',file[0]),'utf8');if(req.url==='/')content=content.replace('<script src="renderer.js">','<script src="preview-bridge.js"></script><script src="renderer.js">');res.setHeader('Content-Type',file[1]+'; charset=utf-8');res.end(content);}catch{res.writeHead(500);res.end();}
}).listen(4317,'127.0.0.1',()=>console.log('UI preview: http://127.0.0.1:4317'));
