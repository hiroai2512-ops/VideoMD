'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell,Tray,Menu,nativeImage,Notification,session}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {Store}=require('./store.cjs');
const {Engine}=require('./engine.cjs');
const {validateSettings,MODELS}=require('./core.cjs');
const {createAuth}=require('./services.cjs');
const {BillingMonitor}=require('./billing.cjs');
app.setName('VideoMD');
app.setPath('userData',path.join(app.getPath('appData'),'VideoMD'));
app.setAppUserModelId('VideoMD.Desktop');
if(!app.requestSingleInstanceLock())app.quit();
let window,tray,store,engine,settings={},monitor,billingTimer,quitting=false;
const page=pathToFileURL(path.join(__dirname,'ui','index.html')).href;
const defaults=()=>({projectId:'',expectedAccount:'',outputDirectory:app.getPath('documents'),adcFile:'',model:MODELS[0],subscription:'',budgetId:''});
function send(channel,value){if(window&&!window.isDestroyed())window.webContents.send(channel,value);}
function register(name,fn){ipcMain.handle(name,async(event,...args)=>{
  if(event.senderFrame?.url!==page)throw new Error('許可されていない画面からの操作です。');
  try{return {ok:true,value:await fn(...args)};}catch(error){return {ok:false,error:error.message};}
});}
async function setupBilling(){
  clearInterval(billingTimer);monitor=null;
  if(!settings.subscription || !settings.budgetId){send('billing',{connected:false,message:'料金通知は未接続です。設定から接続してください。'});return;}
  try{
    const auth=await createAuth(settings);
    monitor=new BillingMonitor({subscription:settings.subscription,budgetId:settings.budgetId,getToken:auth.getToken,loadState:()=>store.read('billing',{}),saveState:value=>store.write('billing',value),onUpdate:value=>send('billing',{...value,connected:true}),onNotify:value=>{if(Notification.isSupported())new Notification({title:value.title,body:value.body}).show();}});
    await monitor.poll();
    billingTimer=setInterval(()=>monitor?.poll().catch(error=>send('billing',{connected:false,message:'料金通知を受信できません。接続設定を確認してください。'})),60000);
  }catch{send('billing',{connected:false,message:'料金通知を受信できません。Google認証・Pub/Subの権限と接続設定を確認してください。'});}
}
app.whenReady().then(async()=>{
  store=new Store(app.getPath('userData'));
  let bootstrap={};
  if(!app.isPackaged) {try{bootstrap=JSON.parse((await fs.readFile(path.join(__dirname,'..','runtime','bootstrap.json'),'utf8')).replace(/^\uFEFF/,''));}catch{}}
  try{settings=await store.read('settings',{...defaults(),...bootstrap});if(bootstrap.subscription){settings.subscription=bootstrap.subscription;settings.budgetId=bootstrap.budgetId;}if(Object.keys(bootstrap).length)await store.write('settings',settings);}catch{settings=defaults();}
  engine=new Engine(store,{onState:value=>send('state',value)});
  await engine.restore();
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  window=new BrowserWindow({show:!process.argv.includes('--smoke-test'),width:1140,height:820,minWidth:760,minHeight:650,title:'VideoMD',backgroundColor:'#f5f4ef',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.setMenuBarVisibility(false);
  window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();if(!settings.subscription&&!engine.state.busy) {quitting=true;app.quit();}}});
  const icon=nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAF0lEQVQ4T2Nk+M/wn4ECwESJ5lEDRg0YAAAK+wIfXyvxiAAAAABJRU5ErkJggg==');
  tray=new Tray(icon);tray.setToolTip('VideoMD — 文字起こしと料金通知');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'VideoMDを開く',click:()=>window.show()},{label:'完全終了',click:()=>{quitting=true;engine.cancel();app.quit();}}]));tray.on('double-click',()=>window.show());
  register('initial',async()=>({settings,state:engine.state,billing:await store.read('billing',{}),version:app.getVersion()}));
  register('settings',async value=>{if(engine.state.busy)throw new Error('処理中は設定を変更できません。');settings=validateSettings(value);await store.write('settings',settings);await setupBilling();return settings;});
  register('choose-folder',async()=>{const result=await dialog.showOpenDialog(window,{properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0];});
  register('choose-adc',async()=>{const result=await dialog.showOpenDialog(window,{title:'既存のGoogle ADC認証ファイルを選択',filters:[{name:'JSON',extensions:['json']}],properties:['openFile']});return result.canceled?null:result.filePaths[0];});
  register('verify-auth',async()=>{const auth=await createAuth(validateSettings(settings));return {email:auth.email};});
  register('start',async input=>engine.run({url:input.url,settings},{resume:input.resume===true}));
  register('cancel',()=>engine.cancel());
  register('open-output',async()=>{if(!engine.state.outputPath)throw new Error('保存済みファイルがありません。');return shell.openPath(engine.state.outputPath);});
  register('open-folder',()=>{if(engine.state.outputPath)shell.showItemInFolder(engine.state.outputPath);});
  register('poll-billing',async()=>{if(!monitor)throw new Error('料金通知は未接続です。設定と認証を確認してください。');return monitor.poll();});
  register('quit',()=>{quitting=true;engine.cancel();app.quit();});
  await window.loadFile(path.join(__dirname,'ui','index.html'));
  if(process.argv.includes('--smoke-test')) {
    const result=await window.webContents.executeJavaScript('window.videoMD.getInitial().then(r => ({ipc:r.ok,model:r.value?.settings.model,controls:document.querySelectorAll("button").length}))');
    console.log(JSON.stringify({windowLoaded:true,...result}));quitting=true;app.quit();return;
  }
  await setupBilling();
  if(app.isPackaged) {
    const shortcut=path.join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs','VideoMD.lnk');
    shell.writeShortcutLink(shortcut,'create',{target:process.execPath,cwd:path.dirname(process.execPath),description:'YouTube動画をMarkdownへ保存',appUserModelId:'VideoMD.Desktop'});
  }
}).catch(()=>{dialog.showErrorBox('VideoMD','アプリを起動できませんでした。保存済みデータを保持したまま終了します。');app.quit();});
app.on('second-instance',()=>{if(window){window.show();window.focus();}});
app.on('before-quit',()=>{quitting=true;clearInterval(billingTimer);engine?.cancel();});
app.on('window-all-closed',()=>{if(quitting)app.quit();});
