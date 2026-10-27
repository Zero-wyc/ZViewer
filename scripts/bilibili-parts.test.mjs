import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm'

async function load(root='../frontend/src/') {
 const context=createContext({Set,Number,Error})
 const source=await readFile(new URL(root+'modules/music/bilibiliPlaylist.ts',import.meta.url),'utf8')
 const module=new SourceTextModule(stripTypeScriptTypes(source),{context})
 await module.link(name=>{const values=name.includes('neteaseImage')?{portableMusicCoverUrl:value=>value}:{getBilibiliVideoView:async()=>{throw Error('No live request')}};
 return new SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value)},{context})})
 await module.evaluate();return module.namespace
}
const item={bvid:'BV1BDk2YCEHF',title:'150 songs',duration:40057,pic:'https://fixture.invalid/cover.jpg'}
const view={...item,cid:101,upName:'fixture',pages:[{page:2,cid:202,part:'第二首',duration:250},{page:1,cid:101,part:'第一首',duration:212}]}

test('each ordered CID becomes one song with its own duration and title',async()=>{
 const api=await load();const tracks=api.expandBilibiliParts(item,view)
 assert.deepEqual(Array.from(tracks,track=>[track.biliCid,track.name,track.durationMs]),[[101,'第一首',212000],[202,'第二首',250000]])
 assert.ok(tracks.every(track=>track.album==='150 songs'&&track.biliBvid===item.bvid))
})
test('legacy pages with missing durations never inherit the entire collection duration',async()=>{
 const api=await load();const tracks=api.expandBilibiliParts(item,{...view,pages:view.pages.map(({duration,...page})=>page)})
 assert.ok(tracks.every(track=>track.durationMs===0))
 const single=api.expandBilibiliParts(item,{...view,duration:35830,pages:[{page:1,cid:101,part:'complete',duration:35830}]})
 assert.equal(single[0].durationMs,35830000)
})
test('150 parts import in sequence and start only after the first acknowledged write',async()=>{
 const api=await load();const order=[],playing=[]
 const tracks=api.expandBilibiliParts(item,{...view,pages:Array.from({length:150},(_,index)=>({page:index+1,cid:index+1,part:String(index+1),duration:212}))})
 await api.enqueueBilibiliParts(tracks,{isCurrent:()=>true,enqueue:async track=>order.push(track.biliCid),play:track=>playing.push([track.biliCid,order.length])})
 assert.deepEqual(order,Array.from({length:150},(_,index)=>index+1));assert.deepEqual(playing,[[1,1]])
})
test('failure and a replaced room cannot start or continue a stale batch',async()=>{
 const api=await load();const tracks=api.expandBilibiliParts(item,view);let current=true,writes=0,plays=0
 await api.enqueueBilibiliParts(tracks,{isCurrent:()=>current,enqueue:async()=>{writes++;current=false},play:()=>plays++})
 assert.equal(writes,1);assert.equal(plays,0)
 await assert.rejects(api.enqueueBilibiliParts(tracks,{isCurrent:()=>true,enqueue:async()=>{throw Error('denied')},play:()=>plays++}),/denied/)
 assert.equal(plays,0)
})
