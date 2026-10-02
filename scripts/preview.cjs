'use strict';
// Development-only layout preview. No cloud calls, credentials or filesystem IPC.
const http=require('node:http');const fs=require('node:fs/promises');const path=require('node:path');
const files={'/':['index.html','text/html'],'/renderer.js':['renderer.js','text/javascript'],'/style.css':['style.css','text/css']};
http.createServer(async(req,res)=>{
  if(req.url==='/preview-bridge.js'){res.setHeader('Content-Type','text/javascript');res.end(`window.videoMD={getInitial:async()=>({ok:true,value:{settings:{projectId:'preview-project',expectedAccount:'preview@example.test',outputDirectory:'C:\\\\VideoMD',model:'gemini-3.8-flash'},state:{phase:'idle',message:'画面プレビュー。API処理は実行しません。',busy:false},billing:{connected:false},version:'0.1.0'}}),onState:()=>{},onBilling:()=>{}};`);return;}
  const file=files[req.url];if(!file){res.writeHead(404);res.end();return;}
  try{let content=await fs.readFile(path.join(__dirname,'..','src','ui',file[0]),'utf8');if(req.url==='/')content=content.replace('<script src="renderer.js">','<script src="preview-bridge.js"></script><script src="renderer.js">');res.setHeader('Content-Type',file[1]+'; charset=utf-8');res.end(content);}catch{res.writeHead(500);res.end();}
}).listen(4317,'127.0.0.1',()=>console.log('UI preview: http://127.0.0.1:4317'));
