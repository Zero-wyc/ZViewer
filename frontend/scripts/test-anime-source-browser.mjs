import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))

test('shared anime browser scrolls large results, shows posters and retries failed selections', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react'
        import { createRoot } from 'react-dom/client'
        import { AnimeSourceBrowser } from './src/modules/room/components/AnimeSourceBrowser'
        const getSources=async()=>[{id:'a',name:'Fixture A'},{id:'b',name:'Fixture B'}]
        localStorage.setItem('zviewer-access-token','fixture-token')
        const search=async(source)=>Array.from({length:120},(_,i)=>({id:source+'/show/'+i,title:'Show '+i,source,cover:location.origin+(i===0?'/blocked.svg':'/cover.svg')}))
        const getEpisodes=async()=>Array.from({length:3600},(_,i)=>({id:String(i),title:'Episode '+i,episodeNumber:i+1,playbackParams:{}}))
        window.batches=[];window.closeCount=0
        createRoot(document.getElementById('root')).render(<AnimeSourceBrowser open kind="kazumi" title="Fixture"
          getSources={getSources} search={search} getEpisodes={getEpisodes}
          onOpenChange={()=>window.closeCount++} onSelectEpisode={()=>{throw Error('Selection must wait for confirmation')}}
          onSelectEpisodes={async items=>{window.batches.push(items);return window.batches.length===1?[items[0].episode.id]:items.map(i=>i.episode.id)}} />)
      `,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    alias: { '@': path.join(root, 'src') },
    define: { 'import.meta.env': '{}' },
  })
  const css = readFileSync(
    path.join(
      root,
      'dist/assets',
      readdirSync(path.join(root, 'dist/assets')).find((f) =>
        f.endsWith('.css')
      )
    )
  )
  const server = createServer((req, res) => {
    if (req.url === '/app.js') {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(bundle.outputFiles[0].text)
    } else if (req.url === '/app.css') {
      res.setHeader('Content-Type', 'text/css')
      res.end(css)
    } else if (req.url === '/blocked.svg') {
      res.statusCode = 403
      res.end('blocked')
    } else if (req.url.startsWith('/api/stream/kazumi/proxy?')) {
      assert.equal(req.headers.authorization, 'Bearer fixture-token')
      res.setHeader('Content-Type', 'image/svg+xml')
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="120"><rect width="80" height="120" fill="blue"/></svg>'
      )
    } else if (req.url === '/cover.svg') {
      res.setHeader('Content-Type', 'image/svg+xml')
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="120"><rect width="80" height="120" fill="blue"/></svg>'
      )
    } else {
      res.setHeader('Content-Type', 'text/html')
      res.end(
        '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
      )
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium
    .launch({ channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || undefined })
    .catch((error) => {
      server.close()
      throw error
    })
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    })
    page.on('pageerror', (error) =>
      console.error('fixture page error:', error.message)
    )
    page.setDefaultTimeout(10000)
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button', { name: 'Fixture A', exact: true }).waitFor()
    const rowAligned = await page
      .getByRole('button', { name: 'Fixture A', exact: true })
      .evaluate((button) => {
        const source = button.getBoundingClientRect()
        const search = document
          .querySelector('input[placeholder="输入番剧名称搜索"]')
          .getBoundingClientRect()
        return (
          Math.abs(
            source.y + source.height / 2 - search.y - search.height / 2
          ) < 1 && source.right < search.left
        )
      })
    assert.ok(rowAligned)
    assert.equal(await page.getByText('上级目录', { exact: true }).count(), 0)
    await page.getByPlaceholder('输入番剧名称搜索').fill('test')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByText('Show 119', { exact: true }).waitFor()
    await page.getByRole('button', { name: '海报墙', exact: true }).click()
    await page.getByAltText('Show 0', { exact: true }).waitFor()
    await page.waitForFunction(
      () => document.querySelector('img[alt="Show 0"]')?.naturalWidth > 0
    )
    assert.ok(
      (
        await page.getByAltText('Show 0', { exact: true }).getAttribute('src')
      ).startsWith('blob:')
    )
    assert.ok(
      (await page
        .getByText('Show 0', { exact: true })
        .evaluate((e) => e.closest('.group').getBoundingClientRect().height)) >
        200
    )
    await page.getByText('Show 119', { exact: true }).scrollIntoViewIfNeeded()
    assert.ok(await page.getByText('Show 119', { exact: true }).isVisible())
    await page.getByRole('button', { name: '列表', exact: true }).click()
    assert.ok(
      (await page
        .getByText('Show 0', { exact: true })
        .evaluate((e) => e.parentElement.getBoundingClientRect().height)) >= 40
    )
    await page.getByText('Show 0', { exact: true }).click()
    await page.getByText('Episode 3599', { exact: true }).waitFor()
    assert.equal(await page.getByRole('img').count(), 0)
    const episodePositions = await Promise.all(
      [0, 1, 2].map((i) =>
        page.getByText('Episode ' + i, { exact: true }).boundingBox()
      )
    )
    assert.ok(
      episodePositions.every(
        (position) => Math.abs(position.y - episodePositions[0].y) < 1
      )
    )
    assert.ok(
      episodePositions[0].x < episodePositions[1].x &&
        episodePositions[1].x < episodePositions[2].x
    )
    await page.getByRole('button', { name: '多选', exact: true }).click()
    await page.getByText('Episode 0', { exact: true }).click()
    await page.getByText('Episode 2', { exact: true }).click()
    assert.equal(await page.evaluate(() => window.batches.length), 0)
    await page.getByRole('button', { name: '添加 (2)', exact: true }).click()
    await page.getByText('已选择 1 个条目', { exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate(() => window.batches[0].map((x) => x.episode.id)),
      ['0', '2']
    )
    assert.equal(await page.evaluate(() => window.closeCount), 0)
    await page.getByRole('button', { name: '添加 (1)', exact: true }).click()
    await page.waitForFunction(() => window.closeCount === 1)
    assert.deepEqual(
      await page.evaluate(() => window.batches[1].map((x) => x.episode.id)),
      ['2']
    )
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1280, height: 450 },
    ]) {
      await page.setViewportSize(viewport)
      await page.getByRole('button', { name: '网页全屏', exact: true }).click()
      const footer = await page
        .getByRole('button', { name: '取消', exact: true })
        .boundingBox()
      assert.ok(footer.y >= 0 && footer.y + footer.height <= viewport.height)
      await page
        .getByRole('button', { name: '退出网页全屏', exact: true })
        .click()
    }
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
})
