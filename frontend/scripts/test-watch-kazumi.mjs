import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import {runInNewContext} from 'node:vm'
import {fileURLToPath} from 'node:url'

const root=fileURLToPath(new URL('../src/',import.meta.url))
const read=path=>readFileSync(root+path,'utf8')
test('remounted player cannot reuse the original room recovery snapshot',()=>{
 const expression=read('modules/room/RoomPage.tsx').match(/initialPlayback=\{([^}]+)\}/)[1]
 const recoveredPlayback={currentMovieId:3,currentTime:255}
 assert.equal(runInNewContext(expression,{playerRemountKey:'init',recoveredPlayback}),recoveredPlayback)
 for(const playerRemountKey of [1,2,3])assert.equal(runInNewContext(expression,{playerRemountKey,recoveredPlayback}),null)
})
const helpers={}
runInNewContext(stripTypeScriptTypes(read('modules/player/services/hls-proxy.ts')).replace(/export /g,'')+';Object.assign(exports,{readHlsProxySource,buildHlsProxyRequest,isServerApiUrl})',{URL,URLSearchParams,exports:helpers})

function loaderHarness(kind='kazumi', channel=false) {
 const base='https://server.example/base'
 const source=`${base}/api/stream/${kind}/proxy?url=${encodeURIComponent('https://cdn.example/show/master.m3u8?sig=a%2Fb')}&referer=&userAgent=Fixture&origin=https%3A%2F%2Fanime.example&cookie=source-cookie&token=host-token`
 const channelBase='http://127.0.0.1:9988/private'
 const logicalConnectionUrl=url=>channel?url.replace(channelBase,base):url
 const connectionUrl=url=>channel?url.replace(base,channelBase):url
 let request
 class BaseLoader { load(context,config,callbacks){ request={context,config,callbacks} } }
 const code=read('modules/player/engines/hls-engine.ts')
 const start=code.indexOf('function createProxyLoader('),end=code.indexOf('/** 等待 hls.js',start)
 const exports={}
 runInNewContext(stripTypeScriptTypes(code.slice(start,end))+';exports.createProxyLoader=createProxyLoader',{
  ...helpers,exports,URL,URLSearchParams,Hls:{DefaultConfig:{loader:BaseLoader}},getApiUrl:()=>base,
  logicalConnectionUrl,connectionUrl,isLocalUrl:()=>false,isRelativeUrl:url=>url.startsWith('/'),
  resolveProxyUrl:()=>{throw Error('Unexpected generic proxy')},buildProxyUrl:()=>{throw Error('Unexpected generic proxy')},
  appendAuthToken:url=>{const u=new URL(logicalConnectionUrl(url));u.searchParams.set('token','viewer-token');return connectionUrl(u.href)}
 })
 const Loader=exports.createProxyLoader(connectionUrl(source))
 const loader=new Loader()
 return {source,base,loader,get request(){return request},logicalConnectionUrl,connectionUrl}
}

test('Kazumi and AniSubs master/child playlists, maps, segments and keys keep upstream bases and proxy headers',()=>{
 for(const kind of ['kazumi','anisubs']){
  const h=loaderHarness(kind)
  const contexts=[h.source,'https://cdn.example/show/2000k/playlist.m3u8','https://other-cdn.example/init.mp4','https://cdn.example/show/2000k/0001.ts','https://cdn.example/key.bin?sig=signed%2Fkey']
  for(const url of contexts){
   let args
   const config={timeout:1000},context={url}
   h.loader.load(context,config,{onSuccess:(...values)=>{args=values}})
   const proxy=new URL(h.request.context.url)
   assert.equal(proxy.pathname,`/base/api/stream/${kind}/proxy`)
   assert.equal(proxy.searchParams.get('token'),'viewer-token')
   assert.equal(proxy.searchParams.get('referer'),'')
   assert.equal(proxy.searchParams.get('userAgent'),'Fixture')
   assert.equal(proxy.searchParams.get('cookie'),'source-cookie')
   const upstream=proxy.searchParams.get('url')
   assert.ok(!upstream.includes('/api/stream/'))
   assert.ok(!upstream.includes('host-token')&&!upstream.includes('viewer-token'))
   const response={url:h.request.context.url,data:'manifest'},stats={loaded:8},details={status:200}
   h.request.callbacks.onSuccess(response,stats,context,details)
   assert.equal(response.url,upstream);assert.equal(context.url,upstream)
   assert.equal(args[0],response);assert.equal(args[1],stats);assert.equal(args[2],context);assert.equal(args[3],details)
   assert.equal(h.request.config,config)
  }
 }
})

test('API origin and path prefix are exact; source credentials never become client authentication',()=>{
 assert.equal(helpers.isServerApiUrl('https://server.example/base/api/file','https://server.example/base'),true)
 assert.equal(helpers.isServerApiUrl('https://server.example/other/api/file','https://server.example/base'),false)
 assert.equal(helpers.isServerApiUrl('https://other.example/base/api/file','https://server.example/base'),false)
 assert.equal(helpers.readHlsProxySource('/api/stream/kazumi/proxy?url=javascript%3Aalert(1)','https://server.example'),null)
 const h=loaderHarness('kazumi',true)
 h.loader.load({url:h.connectionUrl(h.source)},{},{onSuccess(){}})
 assert.ok(h.request.context.url.startsWith('http://127.0.0.1:9988/private/api/'))
 const proxy=new URL(h.logicalConnectionUrl(h.request.context.url))
 assert.equal(proxy.searchParams.get('token'),'viewer-token')
 assert.ok(proxy.searchParams.get('url').startsWith('https://cdn.example/'))
})

test('a host accepts a permitted viewer selection while preserving recovery against stale null; viewers accept clear',()=>{
 const code=read('modules/room/watch-together/useWatchTogether.ts')
 const start=code.indexOf('const handleCurrentMovie ='),end=code.indexOf('// 观众端：',start)
 const exports={},state={currentMovieId:1},isHostRef={current:true}
 runInNewContext(stripTypeScriptTypes(code.slice(start,end))+';exports.receive=handleCurrentMovie',{
  exports,isHostRef,useRoomStore:{getState:()=>state},setCurrentMovieId:id=>{state.currentMovieId=id}
 })
 exports.receive({movieId:2});assert.equal(state.currentMovieId,2)

 exports.receive({movieId:null});assert.equal(state.currentMovieId,2)
 isHostRef.current=false;exports.receive({movieId:null});assert.equal(state.currentMovieId,null)

 isHostRef.current=true;exports.receive({movieId:3});assert.equal(state.currentMovieId,3)

})

