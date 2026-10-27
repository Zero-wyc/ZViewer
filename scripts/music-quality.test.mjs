import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'

function quality() {
  const slots=[];let cursor=0,again=false
  const react={useMemo:fn=>fn(),useEffect:()=>{},useState:value=>{
    const index=cursor++
    if(!(index in slots))slots[index]=value
    return[slots[index],next=>{slots[index]=next;again=true}]
  }}
  const source=readFileSync(new URL('../frontend/src/modules/music/hooks/useSongQuality.ts',import.meta.url),'utf8')
  const code=stripTypeScriptTypes(source)
    .replace(/import\s*\{([\s\S]*?)\}\s*from 'react'/,'const {$1}=react')
    .replace("import { apiGet } from '../musicApi'",'const apiGet=()=>{throw Error("unexpected request")}')
    .replace("import { useMusicSettingsStore } from '../store-settings'",'const useMusicSettingsStore=select=>select({level:"lossless"})')
    .replace('export function','function')
  const hook=new Function('react',code+'\nreturn useSongQuality')(react)
  return input=>{let output,renders=0;do{cursor=0;again=false;output=hook(input);if(++renders>25)throw Error('render loop')}while(again);return output}
}

for(const empty of [null,undefined,0,NaN])test(`quality metadata remains stable with an empty song (${String(empty)})`,()=>{
  const read=quality();assert.equal(read(123),'LOSSLESS');assert.equal(read(empty),'LOSSLESS');assert.equal(read(empty),'LOSSLESS')
})
