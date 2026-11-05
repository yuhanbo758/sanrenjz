'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { AccountAvatarStore } = require('../app/account-avatar-store');

function crc32(bytes) {
    let result = 0xffffffff;
    for (const byte of bytes) { result ^= byte; for (let i=0;i<8;i++) result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0); }
    return (result ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes = Buffer.alloc(0)) {
    const output = Buffer.alloc(bytes.length + 12); output.writeUInt32BE(bytes.length); output.write(type, 4); bytes.copy(output,8);
    output.writeUInt32BE(crc32(output.subarray(4, output.length-4)), output.length-4); return output;
}
function png(width=32, height=16, metadata=false, palette=false) {
    const header=Buffer.alloc(13); header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=palette?3:6;
    const rows=Buffer.alloc(height*(width*(palette?1:4)+1));
    const pieces=[Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header)];
    if(palette)pieces.push(chunk('PLTE',Buffer.from([20,40,60,100,150,200])),chunk('tRNS',Buffer.from([0,255])));
    if(metadata)pieces.push(chunk('tEXt',Buffer.from('Comment\0private-avatar-fixture')),chunk('eXIf',Buffer.from('private-metadata-fixture')));
    pieces.push(chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND'));return Buffer.concat(pieces);
}
function fakeNative({ preserveBuffer=false, metadata=false, empty=false }={}) {
    const calls=[];
    const image=(width,height,original)=>({
        isEmpty:()=>empty,
        getSize:()=>({width,height}),
        resize(options){calls.push({type:'resize',...options});return image(options.width,options.height,preserveBuffer?original:null);},
        toPNG(){return original&&preserveBuffer?Buffer.from(original):png(width,height,metadata);}
    });
    return {calls,createFromBuffer(bytes){calls.push({type:'decode',bytes:bytes.length});return image(bytes.readUInt32BE(16),bytes.readUInt32BE(20),bytes);}};
}
async function isolated(callback) {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'sanrenjz-local-avatar-'));
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
    try {return await callback(root);} finally {await fs.rm(root,{recursive:true,force:true});}
}
async function fixture(root, options={}) {
    const directory=path.join(root,'account-avatar'), nativeImage=fakeNative(options), selections=[];
    const dialog={calls:[],async showOpenDialog(parent,settings){this.calls.push({parent,settings});return selections.shift()||{canceled:true,filePaths:[]};}};
    const store=new AccountAvatarStore({directory,nativeImage,dialog});
    const select=async(bytes=png(),name='selected.png')=>{const file=path.join(root,name);await fs.writeFile(file,bytes);selections.push({canceled:false,filePaths:[file]});return store.select({fixtureParent:true});};
    return {store,directory,nativeImage,dialog,selections,select};
}
async function quiet(callback) {const previous=console.warn,warnings=[];console.warn=(...args)=>warnings.push(args.join(' '));try{return await callback(warnings);}finally{console.warn=previous;}}
const files = directory => fs.readdir(directory);

test('未设置头像读取和重置不创建目录，不接触宿主设置',()=>isolated(async root=>{
    const {store,directory}=await fixture(root),settings=path.join(root,'settings.json');await fs.writeFile(settings,'{"keep":"original"}');
    assert.deepEqual(await store.get(),{custom:false,dataUrl:null});assert.deepEqual(await store.reset(),{custom:false,dataUrl:null});
    await assert.rejects(fs.stat(directory),{code:'ENOENT'});assert.equal(await fs.readFile(settings,'utf8'),'{"keep":"original"}');
}));

test('只通过系统dialog选图，取消保留旧图且可跨实例读取',()=>isolated(async root=>{
    const f=await fixture(root),selected=await f.select();assert(selected.custom&&selected.dataUrl.startsWith('data:image/png;base64,'));
    const manifest=JSON.parse(await fs.readFile(path.join(f.directory,'avatar.json'),'utf8'));
    assert.match(manifest.filename,/^[a-f0-9]{64}\.png$/);assert.equal(manifest.filename,`${manifest.sha256}.png`);
    const reopened=new AccountAvatarStore({directory:f.directory,nativeImage:f.nativeImage,dialog:f.dialog});assert.deepEqual(await reopened.get(),selected);
    const before=await fs.readFile(path.join(f.directory,'avatar.json'));f.selections.push({canceled:true,filePaths:[]});assert.deepEqual(await f.store.select(),{...selected,cancelled:true});assert((await fs.readFile(path.join(f.directory,'avatar.json'))).equals(before));
    assert.deepEqual(f.dialog.calls[0].settings.properties,['openFile']);assert.deepEqual(f.dialog.calls[0].parent,{fixtureParent:true});
}));

test('缩小到512以内并剔除缓存PNG中的文本和EXIF，保留调色板透明度块',()=>isolated(async root=>{
    const f=await fixture(root,{metadata:true}),selected=await f.select(png(1024,256));
    const resize=f.nativeImage.calls.find(call=>call.type==='resize');assert.equal(resize.width,512);assert.equal(resize.height,128);
    const bytes=Buffer.from(selected.dataUrl.split(',')[1],'base64');assert(!bytes.includes(Buffer.from('private-avatar-fixture')));assert(!bytes.includes(Buffer.from('eXIf')));assert.equal(bytes.readUInt32BE(16),512);
    const p=await fixture(path.join(root,'palette-fixture'),{preserveBuffer:true});await fs.mkdir(path.join(root,'palette-fixture'),{recursive:true});
    const result=await p.select(png(3,2,true,true));const palette=Buffer.from(result.dataUrl.split(',')[1],'base64');assert(palette.includes(Buffer.from('PLTE'))&&palette.includes(Buffer.from('tRNS')));assert(!palette.includes(Buffer.from('tEXt'))&&!palette.includes(Buffer.from('eXIf')));
}));

test('选择同一图复用hash文件，换图只删除旧受控图，重置保留无关文件和原图',()=>isolated(async root=>{
    const f=await fixture(root);await f.select();const initial=(await files(f.directory)).sort();await f.select();assert.deepEqual((await files(f.directory)).sort(),initial);
    await fs.writeFile(path.join(f.directory,'unrelated.png'),'keep');await f.select(png(64,32),'second.png');
    const manifest=JSON.parse(await fs.readFile(path.join(f.directory,'avatar.json'),'utf8'));assert.deepEqual((await files(f.directory)).sort(),['avatar.json',manifest.filename,'unrelated.png'].sort());
    await f.store.reset();assert.deepEqual(await files(f.directory),['unrelated.png']);assert((await fs.readFile(path.join(root,'selected.png'))).equals(png()));
}));

test('损坏manifest或图片回默认并只给通用warning，不覆盖原字节',()=>isolated(async root=>quiet(async warnings=>{
    const f=await fixture(root);await f.select();const manifestPath=path.join(f.directory,'avatar.json');await fs.writeFile(manifestPath,'{broken-private-fixture');
    const first=await f.store.get();assert.equal(first.custom,false);assert.equal(first.dataUrl,null);assert(first.warning);await f.store.get();assert.equal(warnings.length,1);assert(!warnings.join('').includes(root));assert(!warnings.join('').includes('broken-private-fixture'));
    assert.equal(await fs.readFile(manifestPath,'utf8'),'{broken-private-fixture');
    await fs.writeFile(manifestPath,JSON.stringify({version:1,filename:'../../outside.json',sha256:'a'.repeat(64)}));await f.store.reset();await assert.rejects(fs.stat(manifestPath),{code:'ENOENT'});
    assert((await files(f.directory)).some(name=>/\.png$/.test(name)),'未知归属的旧PNG不批量删除');
})));

test('摘要不符或解码为空时不修写原图',()=>isolated(async root=>quiet(async()=>{
    const f=await fixture(root);await f.select();const manifest=JSON.parse(await fs.readFile(path.join(f.directory,'avatar.json'),'utf8')),file=path.join(f.directory,manifest.filename);await fs.appendFile(file,'corruption');
    assert.equal((await f.store.get()).custom,false);assert((await fs.readFile(file)).subarray(-10).equals(Buffer.from('corruption')));
    const empty=new AccountAvatarStore({directory:f.directory,nativeImage:fakeNative({empty:true}),dialog:f.dialog});assert.equal((await empty.get()).custom,false);
})));

test('超过5MB、16M像素或伪装格式在nativeImage解码前拒绝',()=>isolated(async root=>{
    const f=await fixture(root);const huge=png();huge.writeUInt32BE(5000,16);huge.writeUInt32BE(5000,20);
    await assert.rejects(f.select(huge,'large-pixels.png'),/1600/);await assert.rejects(f.select(Buffer.alloc(5*1024*1024+1),'large-bytes.png'),/5 MB/);
    await assert.rejects(f.select(Buffer.from('<svg/>'),'disguised.png'),/有效/);await assert.rejects(f.select(png(),'wrong.jpg'),/格式/);assert.equal(f.nativeImage.calls.length,0);
    await assert.rejects(fs.stat(f.directory),{code:'ENOENT'});
}));

test('JPEG大尺寸先拒绝，未支持的WebP明确拒绝并保留旧图',()=>isolated(async root=>{
    const f=await fixture(root),jpeg=Buffer.from([255,216,255,192,0,8,8,0x13,0x88,0x13,0x88,1,255,217]);
    await assert.rejects(f.select(jpeg,'large.jpg'),/1600/);
    assert.equal(f.nativeImage.calls.length,0);
    const before=await f.select(),webp=Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAoAAEAfQsUY0uaCBiOh/AAA=','base64');
    await assert.rejects(f.select(webp,'unsupported.webp'),/PNG 或 JPEG/);assert.deepEqual(await f.store.get(),before);
}));

test('目录链接不允许读取或重置外部manifest，Windows使用junction',()=>isolated(async root=>quiet(async()=>{
    const outside=path.join(root,'outside'),link=path.join(root,'account-avatar');await fs.mkdir(outside);const content='{"external":"keep"}';await fs.writeFile(path.join(outside,'avatar.json'),content);
    await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');const store=new AccountAvatarStore({directory:link,nativeImage:fakeNative(),dialog:{showOpenDialog:async()=>({canceled:true})}});
    const result=await store.get();assert(!result.custom&&result.warning);await assert.rejects(store.reset(),/目录无效/);assert.equal(await fs.readFile(path.join(outside,'avatar.json'),'utf8'),content);
})));

test('userData父根合法迁移junction仍可在直接普通子目录保存和重置',()=>isolated(async root=>{
    const realProfile=path.join(root,'real-profile'),profileLink=path.join(root,'profile-link');await fs.mkdir(realProfile);
    await fs.symlink(realProfile,profileLink,process.platform==='win32'?'junction':'dir');
    const image=path.join(root,'selected.png');await fs.writeFile(image,png());
    const store=new AccountAvatarStore({directory:path.join(profileLink,'account-avatar'),nativeImage:fakeNative(),dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[image]})}});
    const selected=await store.select();assert(selected.custom);assert.deepEqual(await store.get(),selected);assert((await fs.readdir(path.join(realProfile,'account-avatar'))).includes('avatar.json'));
    await store.reset();assert.deepEqual(await fs.readdir(path.join(realProfile,'account-avatar')),[]);
}));

test('忙碌时拒绝重复选图及重置，读取等待当前操作，不排队弹多框',()=>isolated(async root=>{
    const f=await fixture(root);let release;f.dialog.showOpenDialog=()=>new Promise(resolve=>{release=resolve;});
    const pending=f.store.select();await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.store.select(),/正在进行/);await assert.rejects(f.store.reset(),/正在进行/);
    let readDone=false;const reading=f.store.get().then(result=>{readDone=true;return result;});await new Promise(resolve=>setImmediate(resolve));assert.equal(readDone,false);
    release({canceled:true,filePaths:[]});assert.equal((await pending).cancelled,true);assert.deepEqual(await reading,{custom:false,dataUrl:null});
}));

test('manifest原子切换失败保留旧图并清理本次临时文件和新图',()=>isolated(async root=>{
    const f=await fixture(root),before=await f.select(),oldFiles=(await files(f.directory)).sort(),oldManifest=await fs.readFile(path.join(f.directory,'avatar.json')),rename=fs.rename;
    fs.rename=async(from,to)=>{if(to===path.join(f.directory,'avatar.json'))throw Object.assign(new Error('fixture'),{code:'EPERM'});return rename(from,to);};
    try{await assert.rejects(f.select(png(64,32),'new.png'),/原头像已保留/);}finally{fs.rename=rename;}
    assert.deepEqual((await files(f.directory)).sort(),oldFiles);assert((await fs.readFile(path.join(f.directory,'avatar.json'))).equals(oldManifest));assert.deepEqual(await f.store.get(),before);
}));

test('wx临时文件冲突不能删除外来文件，旧头像不变',()=>isolated(async root=>{
    const f=await fixture(root),before=await f.select(),token=crypto.randomUUID(),temp=path.join(f.directory,`.avatar-image-${token}.tmp`),uuid=crypto.randomUUID;await fs.writeFile(temp,'foreign-owner');crypto.randomUUID=()=>token;
    try{await assert.rejects(f.select(png(64,32),'new.png'),/原头像已保留/);}finally{crypto.randomUUID=uuid;}
    assert.equal(await fs.readFile(temp,'utf8'),'foreign-owner');assert.deepEqual(await f.store.get(),before);
}));

test('wx manifest临时文件冲突不删外来文件，也不留下本次新图',()=>isolated(async root=>{
    const f=await fixture(root),before=await f.select(),token=crypto.randomUUID(),temp=path.join(f.directory,`.avatar-manifest-${token}.tmp`),uuid=crypto.randomUUID;await fs.writeFile(temp,'foreign-manifest');const old=(await files(f.directory)).sort();crypto.randomUUID=()=>token;
    try{await assert.rejects(f.select(png(64,32),'new.png'),/原头像已保留/);}finally{crypto.randomUUID=uuid;}
    assert.equal(await fs.readFile(temp,'utf8'),'foreign-manifest');assert.deepEqual((await files(f.directory)).sort(),old);assert.deepEqual(await f.store.get(),before);
}));

test('既有同hash路径内容不符时拒绝覆盖或删除',()=>isolated(async root=>{
    const f=await fixture(root),before=await f.select(),next=png(64,32),hash=crypto.createHash('sha256').update(next).digest('hex'),target=path.join(f.directory,`${hash}.png`);await fs.writeFile(target,'foreign-file');
    await assert.rejects(f.select(next,'new.png'),/原头像已保留/);assert.equal(await fs.readFile(target,'utf8'),'foreign-file');assert.deepEqual(await f.store.get(),before);
}));

test('已拥有文件的中途写入失败才清理本次部分文件',()=>isolated(async root=>{
    const f=await fixture(root),before=await f.select(),old=(await files(f.directory)).sort(),open=fs.open;
    fs.open=async(file,...args)=>{const handle=await open(file,...args);if(String(file).includes('.avatar-image-'))return{writeFile:async bytes=>{await handle.writeFile(bytes.subarray(0,10));throw Object.assign(new Error('fixture'),{code:'ENOSPC'});},sync:()=>handle.sync(),close:()=>handle.close()};return handle;};
    try{await assert.rejects(f.select(png(64,32),'new.png'),/原头像已保留/);}finally{fs.open=open;}
    assert.deepEqual((await files(f.directory)).sort(),old);assert.deepEqual(await f.store.get(),before);
}));

test('重置manifest删除失败不删除旧图，错误不包含真实路径',()=>isolated(async root=>{
    const f=await fixture(root),before=await f.select(),old=(await files(f.directory)).sort(),unlink=fs.unlink;
    fs.unlink=async file=>{if(file===path.join(f.directory,'avatar.json'))throw Object.assign(new Error(root),{code:'EACCES'});return unlink(file);};
    try{await assert.rejects(f.store.reset(),error=>error.message.includes('原头像已保留')&&!error.message.includes(root));}finally{fs.unlink=unlink;}
    assert.deepEqual((await files(f.directory)).sort(),old);assert.deepEqual(await f.store.get(),before);
}));
