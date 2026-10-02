'use strict';
const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
for(const directory of ['src','tests','scripts']) {
  const walk=dir=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())walk(file);else if(/\.(cjs|js)$/.test(file))execFileSync(process.execPath,['--check',file],{stdio:'inherit'});}};
  walk(directory);
}
console.log('JavaScript syntax OK');
