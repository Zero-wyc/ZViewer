import asyncio
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
from playwright.async_api import async_playwright

BASE_URL = "http://localhost:5174"
API_URL = "http://localhost:3000"
BV = "BV1GJ411x7h7"
MP4_URL = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
SCREENSHOT_DIR = Path(r"c:\Users\Zero_\AppData\Local\Temp\trae\screenshots")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)


def log(msg: str):
    print(f"[VERIFY] {msg}", flush=True)


def get_token() -> str:
    req = urllib.request.Request(
        f"{API_URL}/api/auth/login",
        data=json.dumps({"username": "root", "password": "root"}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        data = json.loads(res.read().decode("utf-8"))
        return data["accessToken"]


async def wait_for_video_ready(page, timeout=30000):
    video = page.locator("video").first
    start = time.time()
    while time.time() - start < timeout / 1000:
        ok = await video.evaluate("el => el.readyState >= 3")
        if ok:
            return True
        await asyncio.sleep(0.2)
    return False


async def controls_visible(page) -> bool:
    return await page.evaluate("""() => {
        const btn = document.querySelector('button[aria-label="设置"]');
        if (!btn) return false;
        let el = btn.parentElement;
        while (el && el !== document.body) {
            if (el.classList.contains('transition-opacity')) {
                return !el.classList.contains('opacity-0');
            }
            el = el.parentElement;
        }
        return btn.getBoundingClientRect().height > 0;
    }""")


async def video_container_fullscreen(page) -> bool:
    return await page.evaluate("""() => {
        const video = document.querySelector('video');
        if (!video) return false;
        const container = video.parentElement;
        return container && container.classList.contains('fixed') && container.classList.contains('inset-0');
    }""")


async def wait_for_no_resolving_overlay(page, timeout=60000):
    try:
        # 解析/加载进度提示通常包含 "正在" 文本
        await page.locator('text=正在').first.wait_for(state="hidden", timeout=timeout)
    except Exception:
        pass


async def run():
    token = get_token()
    log("登录 token 获取成功")

    results = {
        "bilibili_parse_options_visible": False,
        "fnval_hevc": False,
        "fnval_av1": False,
        "fnval_avc": False,
        "prefer_cdn": False,
        "auto_hide": False,
        "hide_button": False,
        "web_fullscreen": False,
        "parse_to_picture_ms": None,
    }

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 720})
        page = await context.new_page()

        def on_console(msg):
            if msg.type == "error":
                print(f"[CONSOLE ERROR] {msg.text}", flush=True)
        page.on("console", on_console)

        resolve_requests = []

        def on_request(req):
            if "/api/stream/resolve-bilibili" in req.url:
                resolve_requests.append(req.url)
                log(f"resolve request: {req.url[:180]}")
        page.on("request", on_request)

        # 0. 登录 root 账号
        log("登录 root 账号")
        await page.goto(f"{BASE_URL}/login", wait_until="networkidle")
        await page.fill('input[placeholder="请输入用户名"]', "root")
        await page.fill('input[placeholder="请输入密码"]', "root")
        await page.click('button:has-text("登录")')
        await page.wait_for_selector('button:has-text("开始共享")', timeout=10000)

        # 1. 创建一起看房间
        log("进入首页")
        await page.click('button:has-text("开始共享")')
        log("选择一起看模式")
        await page.wait_for_selector('button:has-text("一起看")', timeout=10000)
        await page.click('button:has-text("一起看")')
        await page.click('button:has-text("创建房间")')
        await page.wait_for_url(re.compile(r"/room/"), timeout=10000)
        room_url = page.url
        log(f"房间创建成功: {room_url}")

        # 2. 添加并播放 B站 BV，用于验证解析设置
        await page.wait_for_selector('text=添加影片', timeout=10000)
        await page.fill('input[placeholder*="bv 号"]', BV)
        log("开始解析 B站 BV")
        await page.click('button:has-text("解析")')
        await page.wait_for_selector('button:has-text("添加")', timeout=60000)
        log("解析完成，添加影片")
        click_add_at = time.time()
        await page.click('button:has-text("添加")')

        # 影片添加后需从列表点击播放才会设置 currentMovieId 并加载播放器控制栏
        log("点击影片列表播放按钮")
        await page.wait_for_selector('button[title="播放"]', timeout=15000)
        await page.click('button[title="播放"]')

        # 等待播放器控制栏出现
        await page.wait_for_selector('button[aria-label="设置"]', timeout=30000)
        results["parse_to_picture_ms"] = round((time.time() - click_add_at) * 1000)
        log(f"播放器控制栏已出现，耗时: {results['parse_to_picture_ms']}ms")

        # 3. 验证 B站 解析设置面板
        log("打开播放器设置")
        await page.click('button[aria-label="设置"]')
        await page.wait_for_selector('text=B站 解析设置', timeout=5000)
        results["bilibili_parse_options_visible"] = True
        await page.screenshot(path=SCREENSHOT_DIR / "bilibili-parse-options-verification.png")
        log("B站 解析设置面板截图已保存")

        # 切换编码格式并验证 fnval
        codec_select = page.locator('div:has(> label:has-text("编码格式")) select')
        codec_expected = {"hevc": "2128", "av1": "1104", "avc": "80"}
        for codec, expected_fnval in codec_expected.items():
            log(f"切换编码格式: {codec}")
            await codec_select.select_option(codec)
            await asyncio.sleep(2.5)
            matched = any(
                re.search(rf"[?&]fnval={expected_fnval}(?:&|$)", url)
                for url in resolve_requests
            )
            results[f"fnval_{codec}"] = matched
            log(f"fnval={expected_fnval} 请求捕获: {matched}")

        # 输入 CDN 偏好
        log("输入 CDN 偏好: upos")
        cdn_input = page.locator('label:has-text("CDN 偏好") + input')
        await cdn_input.fill("upos")
        await asyncio.sleep(3.5)
        matched_cdn = any(
            re.search(r"[?&]preferCdn=upos(?:&|$)", url)
            for url in resolve_requests
        )
        results["prefer_cdn"] = matched_cdn
        log(f"preferCdn=upos 请求捕获: {matched_cdn}")

        # 关闭设置面板
        await page.mouse.click(640, 360)
        await asyncio.sleep(0.5)

        # 4. 添加一个稳定 MP4 用于验证播放器控制栏行为，避免 B站 CDN 403 导致解析遮罩干扰
        log("添加 MP4 测试片用于控制栏验证")
        # 切到 MP4 源
        source_select = page.locator('select').first
        await source_select.select_option('mp4')
        await asyncio.sleep(0.3)
        await page.fill('input[placeholder*="视频直链"]', MP4_URL)
        await page.click('button:has-text("添加")')
        await page.wait_for_selector('text=BigBuckBunny', timeout=15000)
        await page.locator('button[title="播放"]').last.click()

        # 等待 MP4 实际加载
        ready = await wait_for_video_ready(page, timeout=30000)
        log(f"MP4 视频加载 readyState>=3: {ready}")
        if not ready:
            log("警告: MP4 未成功加载，但继续验证 UI 状态")

        await wait_for_no_resolving_overlay(page, timeout=15000)

        # 5. 验证底栏自动隐藏与隐藏按钮
        log("验证控制栏自动隐藏")
        # 先移出播放器区域，再移入以触发 mouseenter
        await page.mouse.move(50, 400)
        await asyncio.sleep(0.2)
        await page.mouse.move(700, 400)
        await asyncio.sleep(0.5)
        await asyncio.sleep(3.5)
        hidden1 = not await controls_visible(page)
        log(f"静止 3 秒后控制栏隐藏: {hidden1}")
        await page.mouse.move(701, 401)
        await asyncio.sleep(0.5)
        visible1 = await controls_visible(page)
        log(f"移动鼠标后控制栏恢复: {visible1}")
        await page.screenshot(path=SCREENSHOT_DIR / "player-controls-hidden-verification.png")
        log("底栏隐藏状态截图已保存")

        # 确保控制栏显示后再点击隐藏按钮
        await page.mouse.move(702, 402)
        await