'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('videoMD',{
  getInitial:()=>ipcRenderer.invoke('initial'),saveSettings:settings=>ipcRenderer.invoke('settings',settings),
  chooseFolder:()=>ipcRenderer.invoke('choose-folder'),chooseAdc:()=>ipcRenderer.invoke('choose-adc'),
  verifyAuth:()=>ipcRenderer.invoke('verify-auth'),start:input=>ipcRenderer.invoke('start',input),cancel:()=>ipcRenderer.invoke('cancel'),
  openOutput:()=>ipcRenderer.invoke('open-output'),openFolder:()=>ipcRenderer.invoke('open-folder'),
  pollBilling:()=>ipcRenderer.invoke('poll-billing'),quit:()=>ipcRenderer.invoke('quit'),
  onState:callback=>ipcRenderer.on('state',(_event,state)=>callback(state)),
  onBilling:callback=>ipcRenderer.on('billing',(_event,state)=>callback(state)),
});
