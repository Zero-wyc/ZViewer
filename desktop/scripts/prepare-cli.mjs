import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.join(desktop, '.runtime', 'tools', 'zviewer-cli');
const source = path.join(directory, 'source');
const repository = 'https://github.com/Zero-wyc/ZViewerCLI';
const commit = '22a120dcd0c184252125dee5729115a282e4367d';
const toolchain = 'go1.26.9';
const executable = 'zviewer-cli-windows-amd64.exe';
const binarySha256 = '367695f888a96a97aa78841b8bc39c320ea4b15db384e3704fa8b09842e74f6f';
// 按 tag v5.4.0 构建受管 CLI。
// 凭证接口的来源校验与桌面主题已并入上游（v5.4.0），这里不再打任何补丁：
// 受管构建与 GitHub Release 的源码完全一致，差别只剩未压缩与构建工具链固定。
// 与 GitHub Release 的 UPX 产物不同，这里是未压缩的受管构建，供网页下载与桌面端随包。
const sources = {
  'bilibili.go':'5b48735196e6eed996dee0142543540385ce85d3',
  'config.go':'70101a75ffc273653c94cebc90e2ce44725aaa93',
  'main.go':'b1591697c777299f42e73a223d477cc237d911fc',
  'mp4box.go':'b4bbebac15d8cc36d54a0f677627b719c3afcf9c',
  'page.go':'3b35e57172a568c9b582bc237558177f8f75eeb5',
  'resolver.go':'72d229e4e0efb3a10cf3501390c1fabb79726cd0',
  'server.go':'4d067e84b39b5d43d3620e6ee4835596085dcc33',
  'settings_origin.go':'bc2593de12bd441580e0c43c597115de6cb7df0d',
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
  const env = {...process.env,GOTOOLCHAIN:toolchain,GOOS:'windows',GOARCH:'amd64',CGO_ENABLED:'0',GOFLAGS:'',GOAMD64:'v1',GOEXPERIMENT:''};
  const actual = execFileSync('go',['version'],{env,encoding:'utf8',windowsHide:true}).trim();
  if(!actual.includes(' '+toolchain+' ')) throw new Error('CLI build requires '+toolchain+'; got '+actual);
  execFileSync('go',['build','-mod=readonly','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',target,'.'],{cwd:source,env,stdio:'inherit',windowsHide:true});
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
fs.writeFileSync(path.join(directory,'provenance.json'),JSON.stringify({repository,commit,version:'5.4.0',toolchain,platform:'windows-amd64',source:'Built from pinned upstream source; no local patches (settings hardening and desktop theme are upstream as of v5.4.0)',files:[{file:executable,sha256:binarySha256},{file:'LICENSE',sha256:hash(fs.readFileSync(license))},{file:'THIRD-PARTY-NOTICES.txt',sha256:hash(fs.readFileSync(path.join(directory,'THIRD-PARTY-NOTICES.txt')))}],sourceBlobs:sources},null,2)+'\n');
console.log('Source-built ZViewerCLI v5.4.0 verified ('+commit+', '+toolchain+')');
// --publish：把受管构建同步到 frontend/public，作为全项目唯一事实源（网页下载、
// 单文件运行包与桌面端 runtime/ 都取这一份）。与 GitHub Release 的差别只有两点：
// 未做 UPX 压缩（避免杀软误报），以及固定 go1.26.9 工具链保证可复现。
if(process.argv.includes('--publish')) {
  const publicCli = path.join(path.dirname(desktop),'frontend','public',executable);
  fs.mkdirSync(path.dirname(publicCli),{recursive:true});
  fs.copyFileSync(target,publicCli);
  console.log('已同步到 frontend/public/'+executable+'（请提交该文件）');
}
