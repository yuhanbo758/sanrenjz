const {app,BrowserWindow,ipcMain,nativeImage,clipboard}=require('electron');
const assert=require('assert');
const fs=require('fs'),os=require('os'),path=require('path');
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const plugin=path.join(__dirname,'..','app','software','sanrenjz-tools-qr-barcode');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qr-barcode-test-'));
const storage=new Map();let savePath='',openPath='';
ipcMain.on('show-save-dialog',event=>{event.returnValue=savePath});
ipcMain.on('show-open-dialog',event=>{event.returnValue=openPath?[openPath]:[]});
ipcMain.handle('plugin-storage-get-async',(_event,_name,key)=>storage.get(key)??null);
ipcMain.handle('plugin-storage-set-async',(_event,_name,key,value)=>{storage.set(key,value);return true});
async function waitFor(win,condition){for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(condition))return;await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('等待界面状态超时：'+condition)}
app.whenReady().then(async()=>{
 let win;
 try{
  win=new BrowserWindow({show:false,width:1180,height:760,webPreferences:{preload:path.join(plugin,'preload.js'),nodeIntegration:true,contextIsolation:false,webSecurity:false}});
  const errors=[];win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)});
  await win.loadFile(path.join(plugin,'index.html'));
  assert.strictEqual(await win.webContents.executeJavaScript("document.querySelectorAll('.head').length"),0);
  await win.webContents.executeJavaScript("document.querySelector('#content').value='https://sanrenjz.com/test';document.querySelector('#generateBtn').click()");
  await waitFor(win,"current?.kind==='QR'");
  savePath=path.join(dir,'qr.png');await win.webContents.executeJavaScript("document.querySelector('#savePng').click()");
  assert.strictEqual(fs.readFileSync(savePath).subarray(1,4).toString(),'PNG');
  openPath=savePath;
  savePath=path.join(dir,'qr.svg');await win.webContents.executeJavaScript("document.querySelector('#saveSvg').click()");
  assert.match(fs.readFileSync(savePath,'utf8'),/<svg/);
  const qrData=await win.webContents.executeJavaScript("current.dataUrl");
  await win.webContents.executeJavaScript("document.querySelector('[data-mode=scan]').click();loadScanImage("+JSON.stringify(qrData)+");document.querySelector('#recognize').click()");
  await waitFor(win,"recognized==='https://sanrenjz.com/test'");
  await win.webContents.executeJavaScript("document.querySelector('#drop').click();document.querySelector('#recognize').click()");
  await waitFor(win,"recognized==='https://sanrenjz.com/test'");
  clipboard.writeImage(nativeImage.createFromPath(openPath));
  await win.webContents.executeJavaScript("document.querySelector('#pasteImage').click();document.querySelector('#recognize').click()");
  await waitFor(win,"recognized==='https://sanrenjz.com/test'");
  const dropped=fs.readFileSync(openPath).toString('base64');
  await win.webContents.executeJavaScript("(()=>{const bytes=Uint8Array.from(atob("+JSON.stringify(dropped)+"),char=>char.charCodeAt(0));const file=new File([bytes],'dropped.png',{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(file);document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));return true})()");
  await waitFor(win,"document.querySelector('#drop img')?.naturalWidth>0");
  await win.webContents.executeJavaScript("document.querySelector('#recognize').click()");
  await waitFor(win,"recognized==='https://sanrenjz.com/test'");
  await win.webContents.executeJavaScript("document.querySelector('[data-mode=generate]').click();document.querySelector('#kind').value='CODE128';updateKind();document.querySelector('#content').value='ABC123456';document.querySelector('#generateBtn').click()");
  await waitFor(win,"current?.kind==='CODE128'");
  const barData=await win.webContents.executeJavaScript("current.dataUrl");
  assert(nativeImage.createFromDataURL(barData).getSize().width>100);
  savePath=path.join(dir,'bar.svg');await win.webContents.executeJavaScript("document.querySelector('#saveSvg').click()");
  assert.match(fs.readFileSync(savePath,'utf8'),/<svg/);
  await win.webContents.executeJavaScript("document.querySelector('[data-mode=scan]').click();loadScanImage("+JSON.stringify(barData)+");document.querySelector('#recognize').click()");
  await waitFor(win,"recognized==='ABC123456'");
  await win.webContents.executeJavaScript("document.querySelector('[data-mode=generate]').click();document.querySelector('#kind').value='EAN13';updateKind();document.querySelector('#content').value='400638133393';document.querySelector('#generateBtn').click()");
  await waitFor(win,"current?.kind==='EAN13'");
  for(const [kind,value] of [['EAN8','9638507'],['UPC','03600029145'],['CODE39','HELLO123'],['ITF','12345678']]){
    await win.webContents.executeJavaScript("document.querySelector('#kind').value="+JSON.stringify(kind)+";updateKind();document.querySelector('#content').value="+JSON.stringify(value)+";document.querySelector('#generateBtn').click()");
    await waitFor(win,"current?.kind==="+JSON.stringify(kind));
  }
  await win.webContents.executeJavaScript("document.querySelector('#copyImage').click()");
  assert(!clipboard.readImage().isEmpty());
  for(const [width,height] of [[900,650],[1180,760],[1440,900]]){
    win.setSize(width,height);
    const state=await win.webContents.executeJavaScript("(()=>({scrollX:document.documentElement.scrollWidth-innerWidth,scrollY:document.documentElement.scrollHeight-innerHeight,visible:(()=>{const r=document.querySelector('#generateBtn').getBoundingClientRect();return r.top>=32&&r.bottom<=innerHeight})()}))()");
    assert(state.scrollX<=1&&state.scrollY<=1&&state.visible,JSON.stringify({width,height,state}));
  }
  assert.deepStrictEqual(errors,[]);
  assert(storage.get('qr-history-v2').length>=3);
  console.log('qr barcode Electron test passed');app.exit(0);
 }catch(error){console.error(error);app.exit(1)}
 finally{if(win&&!win.isDestroyed())win.destroy();fs.rmSync(dir,{recursive:true,force:true})}
});
