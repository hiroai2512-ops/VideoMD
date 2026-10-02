'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
class Store {
  constructor(root) {this.root=root;}
  async read(name,fallback) {
    try{return JSON.parse(await fs.readFile(path.join(this.root,name+'.json'),'utf8'));}
    catch(error){if(error.code==='ENOENT')return fallback;throw new Error('保存済みデータを読み込めません。データを保持したまま処理を停止しました。');}
  }
  async write(name,value) {
    await fs.mkdir(this.root,{recursive:true});
    const target=path.join(this.root,name+'.json');
    const temp=target+'.'+crypto.randomUUID()+'.tmp';
    try{await fs.writeFile(temp,JSON.stringify(value,null,2),{flag:'wx',encoding:'utf8'});await fs.rename(temp,target);}
    finally{await fs.unlink(temp).catch(()=>{});}
  }
}
module.exports={Store};
