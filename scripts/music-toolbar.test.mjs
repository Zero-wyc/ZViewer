import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'

function toolbar() {
  let scrollable=false, measure
  class Element {
    constructor(top,height,position='static') { Object.assign(this,{offsetTop:top,offsetHeight:height,position}) }
  }
  const el={children:[new Element(0,20),new Element(40,20)],clientHeight:200,paddingBottom:'0px'}
  // A side popup overflows; moving it to a fixed sheet removes that overflow.
  Object.defineProperty(el,'scrollHeight',{get:()=>scrollable?60:800})
  const source=readFileSync(new URL('../frontend/src/modules/music/hooks/useToolbarScrollable.ts',import.meta.url),'utf8')
  const code=stripTypeScriptTypes(source).replace(/import\s*\{([\s\S]*?)\}\s*from 'react'/,'const {$1} = react').replace('export function','function')
  const react={useRef:()=>({current:el}),useState:()=>[scrollable,value=>{scrollable=value}],useCallback:fn=>fn,useLayoutEffect:fn=>{measure=fn},useEffect:()=>{}}
  new Function('react','HTMLElement','getComputedStyle',code+'\nreturn useToolbarScrollable()')(react,Element,node=>node)
  return{el,Element,measure:()=>{measure();return scrollable}}
}

test('a side queue cannot oscillate toolbar scrollability when moved to a sheet',()=>{
  const f=toolbar()
  assert.deepEqual(Array.from({length:10},()=>f.measure()),Array(10).fill(false))
})
test('actual toolbar button overflow still enables scrolling and recovers after resize',()=>{
  const f=toolbar();f.el.clientHeight=40
  assert.equal(f.measure(),true)
  f.el.clientHeight=200
  assert.equal(f.measure(),false)
})
test('positioned queue children are excluded but normal-flow icons and padding count',()=>{
  const f=toolbar();f.el.children.push(new f.Element(100,900,'absolute'),new f.Element(100,900,'fixed'))
  assert.equal(f.measure(),false)
  f.el.paddingBottom='145px'
  assert.equal(f.measure(),true)
})
test('conditional toolbar icons change the measured height independently of popup overflow',()=>{
  const f=toolbar();f.el.children.push(new f.Element(190,20))
  assert.equal(f.measure(),true)
  f.el.children.pop()
  assert.equal(f.measure(),false)
})
