import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {applyCliPatch,patchInfo} from '../patches/cli-settings-origin.cjs';

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.join(desktop, '.runtime', 'tools', 'zviewer-cli');
const source = path.join(directory, 'source');
const repository = 'https://github.com/Zero-wyc/ZViewerCLI';
const commit = '9599bbef8f041e0755f6c815b16d28d3e2cf72be';
const toolchain = 'go1.26.9';
const executable = 'zviewer-cli-windows-amd64.exe';
const binarySha256 = '95e296692e1e7815de9b9a62035284537881b046da116c7daa9abccb356a56d1';
if (patchInfo().sha256 !== '9e5bba199baca8f84b8d0e88855e528abdbf937bf50ff301fe33c50d9effc92b') throw new Error('Local CLI patch checksum mismatch');
// Upstream dist reports v5.2.1. Build the pinned v5.2.1 source instead.
const sources = {
  'bilibili.go':'5b48735196e6eed996dee0142543540385ce85d3',
  'config.go':'cfe996a8fa764eb4ff6ab211473293b99253f3f6',
  'main.go':'7960ea0f6d4342ac305081218a3413c64db7e6e8',
  'mp4box.go':'b4bbebac15d8cc36d54a0f677627b719c3afcf9c',
  'page.go':'d854f908b727bf63276591c97a7df04072c6aa28',
  'resolver.go':'ebcb72f1dd52bdde930ce1e42eaf4a29804ffdb2',
  'server.go':'fc89c934c7f828c67c45c83b995fa58d20ad8899',
  'socket.go':'194eff3402e9526782bdd177e327a19cd466a09e',
  'speedlog.go':'75132ec2e56768802dd0a27d7a59ab89ce5f9786',
  'state.go':'3e45d5808e4ca08505835db46e4fb4f282f1d28e',
  'wbi.go':'567d2c653ed46bcf6efc2e4c03e16cf2af2bcdb6',
  'go.mod':'bc4d7a6a54b0b7f9ab61e5626f2b2ff0508ec585',
  'go.sum':'a78d22816163f19fbc5a170f678de9602a73a349',
  'Nacho.webp':'721de1307e68b57ede12284271850a05d7bf16ef',
  'm4s_head.bin':'7f898a19880d40e650ce0e40b1d836a1037c7d4d',
  'LICENSE':'733edfebe415036e5a357d59c133302d8f20b644'
};
const licenses = [
  {name:'Go',url:'https://raw.githubusercontent.com/golang/go/go1.26.9/LICENSE',sha256:'911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad'},
  {name:'gorilla/websocket',url:'https://raw.githubusercontent.com/gorilla/websocket/v1.5.3/LICENSE',sha256:'2be1b548b0387ca8948e1bb9434e709126904d15f622cc2d0d8e7f186e4d122d'},
  {name:'rs/cors',url:'https://raw.githubusercontent.com/rs/cors/v1.11.1/LICENSE',sha256:'c21f3b628875c093885ba085d13959b5e78841d64a8fe76c10ba7293aec32fc7'},
  {name:'skip2/go-qrcode',url:'https://raw.githubusercontent.com/skip2/go-qrcode/da1b6568686e/LICENSE',sha256:'4cdab772de606bdf53e174b2f5d6a2c398156380ca1f763122198cece531d02c'}
];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const gitHash = bytes => crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
function download(url) {
  return new Promise((resolve,reject) => {
    const request = https.get(url,{headers:{'User-Agent':'ZViewer-Desktop-Build'},timeout:30000}, response => {
      if(response.statusCode !== 200) { response.resume(); reject(new Error('CLI download returned HTTP '+response.statusCode+': '+url)); return; }
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if(size > 16*1024*1024) request.destroy(new Error('CLI download exceeded the expected maximum size')); else chunks.push(chunk); });
      response.on('error',reject);
      response.on('end',() => resolve(Buffer.concat(chunks)));
    });
    request.on('timeout',() => request.destroy(new Error('CLI download timed out: '+url)));
    request.on('error',reject);
  });
}
async function verifiedSource(name) {
  const target = path.join(source,name);
  if(fs.existsSync(target)) {
    if(gitHash(fs.readFileSync(target)) !== sources[name]) throw new Error('Cached CLI source checksum mismatch: '+target);
  } else {
    const bytes = await download('https://raw.githubusercontent.com/Zero-wyc/ZViewerCLI/'+commit+'/'+name);
    if(gitHash(bytes) !== sources[name]) throw new Error('Downloaded CLI source checksum mismatch: '+name);
    fs.writeFileSync(target,bytes,{flag:'wx'});
  }
  return target;
}
fs.mkdirSync(source,{recursive:true});
const target = path.join(directory,executable);
if(fs.existsSync(target)) {
  if(hash(fs.readFileSync(target)) !== binarySha256) throw new Error('Cached CLI checksum mismatch: '+target);
} else {
  for(const name of Object.keys(sources)) await verifiedSource(name);
  const buildSource = path.join(directory,'patched-source');
  applyCliPatch(source,buildSource);
  const env = {...process.env,GOTOOLCHAIN:toolchain,GOOS:'windows',GOARCH:'amd64',CGO_ENABLED:'0',GOFLAGS:'',GOAMD64:'v1',GOEXPERIMENT:''};
  const actual = execFileSync('go',['version'],{env,encoding:'utf8',windowsHide:true}).trim();
  if(!actual.includes(' '+toolchain+' ')) throw new Error('CLI build requires '+toolchain+'; got '+actual);
  execFileSync('go',['build','-mod=readonly','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',target,'.'],{cwd:buildSource,env,stdio:'inherit',windowsHide:true});
  if(hash(fs.readFileSync(target)) !== binarySha256) throw new Error('Built CLI checksum mismatch: '+target);
}
const license = path.join(directory,'LICENSE');
if(fs.existsSync(license)) {
  if(gitHash(fs.readFileSync(license)) !== sources.LICENSE) throw new Error('Cached CLI LICENSE checksum mismatch');
} else fs.copyFileSync(await verifiedSource('LICENSE'),license);
const notices = [];
for(let i=0;i<licenses.length;i++) {
  const entry = licenses[i], cached = path.join(source,'third-party-license-'+i+'.txt');
  const bytes = fs.existsSync(cached) ? fs.readFileSync(cached) : await download(entry.url);
  if(hash(bytes) !== entry.sha256) throw new Error('CLI third-party license checksum mismatch: '+entry.name);
  if(!fs.existsSync(cached)) fs.writeFileSync(cached,bytes,{flag:'wx'});
  notices.push(entry.name+'\n'+'='.repeat(entry.name.length)+'\n'+bytes.toString('utf8'));
}
fs.writeFileSync(path.join(directory,'THIRD-PARTY-NOTICES.txt'),notices.join('\n\n'));
fs.writeFileSync(path.join(directory,'provenance.json'),JSON.stringify({repository,commit,version:'5.2.1',toolchain,platform:'windows-amd64',source:'Built from pinned upstream source with local settings security and optional desktop embedded theme patches',patch:patchInfo(),files:[{file:executable,sha256:binarySha256},{file:'LICENSE',sha256:hash(fs.readFileSync(license))},{file:'THIRD-PARTY-NOTICES.txt',sha256:hash(fs.readFileSync(path.join(directory,'THIRD-PARTY-NOTICES.txt')))}],sourceBlobs:sources},null,2)+'\n');
console.log('Source-built ZViewerCLI v5.2.1 verified ('+commit+', '+toolchain+')');
// --publish：把受管构建同步到 frontend/public，作为全项目唯一事实源（网页下载、
// 单文件运行包与桌面端 runtime/ 都取这一份）。不同步的话桌面包用的是网页里那份
// 官方 release 二进制，不含桌面嵌入式主题与本地配置接口的来源保护。
if(process.argv.includes('--publish')) {
  const publicCli = path.join(path.dirname(desktop),'frontend','public',executable);
  fs.mkdirSync(path.dirname(publicCli),{recursive:true});
  fs.copyFileSync(target,publicCli);
  console.log('已同步到 frontend/public/'+executable+'（请提交该文件）');
}
