import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))

test('anime episode picker supports ordered batch selection and partial failure retry', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react'
        import { createRoot } from 'react-dom/client'
        import { AnimeEpisodePicker } from './src/modules/room/components/AnimeEpisodePicker'
        const episodes = [1,2,3].map(n => ({id: String(n), title: 'Episode '+n, episodeNumber:n, playbackParams:{}}))
        window.batches = []; window.single = []
        createRoot(document.getElementById('root')).render(<AnimeEpisodePicker
          episodes={episodes} sourceId="fixture" title="Show"
          onSelect={e => window.single.push(e.id)}
          onSelectMany={async items => {
            window.batches.push(items)
            await new Promise(resolve => setTimeout(resolve, 100))
            return window.batches.length === 1 ? [items[0].episode.id] : items.map(x => x.episode.id)
          }} />)
      `,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    alias: { '@': path.join(root, 'src') },
  })
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || undefined,
  })
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    })
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole('button', { name: 'Episode 1', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.single), ['1'])
    await page.getByRole('button', { name: '多选', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Episode 3', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Episode 1', exact: true }).check()
    await page.getByRole('button', { name: '添加所选', exact: true }).click()
    await page.getByText('已选 1 集', { exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate(() => window.batches[0].map((x) => x.episode.id)),
      ['1', '3']
    )
    assert.equal(
      await page
        .getByRole('checkbox', { name: 'Episode 3', exact: true })
        .isChecked(),
      true
    )
    assert.equal(
      await page
        .getByRole('checkbox', { name: 'Episode 1', exact: true })
        .isChecked(),
      false
    )
    await page.getByRole('button', { name: '添加所选', exact: true }).click()
    await page.getByText('已选 0 集', { exact: true }).waitFor()
    await page.getByRole('button', { name: '全选', exact: true }).click()
    await page.getByText('已选 3 集', { exact: true }).waitFor()
    await page.getByRole('button', { name: '清空', exact: true }).click()
    await page.getByText('已选 0 集', { exact: true }).waitFor()
    assert.equal(
      await page
        .getByRole('button', { name: '添加所选', exact: true })
        .isDisabled(),
      true
    )
  } finally {
    await browser.close()
  }
})
