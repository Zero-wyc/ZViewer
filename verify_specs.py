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


async def run_browser(p, browser_type: str):
    """在指定浏览器中执行完整的验证流程。"""
    browser_label = "Firefox" if browser_type == "firefox" else "Chromium"
    log(f"启动 {browser_label} 浏览器验证")

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

    launch_func = p.firefox.launch if browser_type == "firefox" else p.chromium.launch
    browser = await launch_func(headless=True)
    context = await browser.new_context(viewport={"width": 1280, "height": 720})
    page = await context.new_page()

    def on_console(msg):
        if msg.type == "error":
            print(f"[CONSOLE ERROR][{browser_label}] {msg.text}", flush=True)
    page.on("console", on_console)

    resolve_requests = []

    def on_request(req):
        if "/api/stream/resolve-bilibili" in req.url:
            resolve_requests.append(req.url)
            log(f"[{browser_label}] resolve request: {req.url[:180]}")
    page.on("request", on_request)

    # 0. 登录 root 账号
    log(f"[{browser_label}] 登录 root 账号")
    await page.goto(f"{BASE_URL}/login", wait_until="networkidle")
    await page.fill('input[placeholder="请输入用户名"]', "root")
    await page.fill('input[placeholder="请输入密码"]', "root")
    await page.click('button:has-text("登录")')
    await page.wait_for_selector('button:has-text("开始共享")', timeout=10000)

    # 1. 创建一起看房间
    log(f"[{browser_label}] 进入首页")
    await page.click('button:has-text("开始共享")')
    log(f"[{browser_label}] 选择一起看模式")
    await page.wait_for_selector('button:has-text("一起看")', timeout=10000)
    await page.click('button:has-text("一起看")')
    await page.click('button:has-text("创建房间")')
    await page.wait_for_url(re.compile(r"/room/"), timeout=10000)
    room_url = page.url
    log(f"[{browser_label}] 房间创建成功: {room_url}")

    # 2. 添加并播放 B站 BV，用于验证解析设置
    await page.wait_for_selector('text=添加影片', timeout=10000)
    await page.fill('input[placeholder*="bv 号"]', BV)
    log(f"[{browser_label}] 开始解析 B站 BV")
    await page.click('button:has-text("解析")')
    await page.wait_for_selector('button:has-text("添加")', timeout=60000)
    log(f"[{browser_label}] 解析完成，添加影片")
    click_add_at = time.time()
    await page.click('button:has-text("添加")')

    # 影片添加后需从列表点击播放才会设置 currentMovieId 并加载播放器控制栏
    log(f"[{browser_label}] 点击影片列表播放按钮")
    await page.wait_for_selector('button[title="播放"]', timeout=15000)
    await page.click('button[title="播放"]')

    # 等待播放器控制栏出现
    await page.wait_for_selector('button[aria-label="设置"]', timeout=30000)
    results["parse_to_picture_ms"] = round((time.time() - click_add_at) * 1000)
    log(f"[{browser_label}] 播放器控制栏已出现，耗时: {results['parse_to_picture_ms']}ms")

    # 3. 验证 B站 解析设置面板
    log(f"[{browser_label}] 打开播放器设置")
    await page.click('button[aria-label="设置"]')
    await page.wait_for_selector('text=B站 解析设置', timeout=5000)
    results["bilibili_parse_options_visible"] = True
    suffix = "firefox" if browser_type == "firefox" else "chromium"
    await page.screenshot(path=SCREENSHOT_DIR / f"bilibili-parse-options-verification-{suffix}.png")
    log(f"[{browser_label}] B站 解析设置面板截图已保存")

    # 切换编码格式并验证 fnval
    codec_select = page.locator('div:has(> label:has-text("编码格式")) select')
    codec_expected = {"hevc": "2128", "av1": "1104", "avc": "80"}
    for codec, expected_fnval in codec_expected.items():
        log(f"[{browser_label}] 切换编码格式: {codec}")
        await codec_select.select_option(codec)
        await asyncio.sleep(2.5)
        matched = any(
            re.search(rf"[?&]fnval={expected_fnval}(?:&|$)", url)
            for url in resolve_requests
        )
        results[f"fnval_{codec}"] = matched
        log(f"[{browser_label}] fnval={expected_fnval} 请求捕获: {matched}")

    # 输入 CDN 偏好
    log(f"[{browser_label}] 输入 CDN 偏好: upos")
    cdn_input = page.locator('label:has-text("CDN 偏好") + input')
    await cdn_input.fill("upos")
    await asyncio.sleep(3.5)
    matched_cdn = any(
        re.search(r"[?&]preferCdn=upos(?:&|$)", url)
        for url in resolve_requests
    )
    results["prefer_cdn"] = matched_cdn
    log(f"[{browser_label}] preferCdn=upos 请求捕获: {matched_cdn}")

    # 关闭设置面板
    await page.mouse.click(640, 360)
    await asyncio.sleep(0.5)

    # 删除 B站 影片，避免其解析失败/重试的遮罩干扰后续控制栏验证
    log(f"[{browser_label}] 删除 B站 测试影片")
    await page.locator('button[title="删除"]').first.click()
    await asyncio.sleep(0.8)

    # 4. 添加一个稳定 MP4 用于验证播放器控制栏行为
    log(f"[{browser_label}] 添加 MP4 测试片用于控制栏验证")
    # 切到 MP4 源
    source_select = page.locator('select:has(option[value="mp4"])').first
    await source_select.select_option('mp4')
    await asyncio.sleep(0.3)
    await page.fill('input[placeholder*="视频直链"]', MP4_URL)
    await page.click('button:has-text("添加")')
    await page.wait_for_selector('text=BigBuckBunny', timeout=15000)
    tags = await page.evaluate("""() => {
        return Array.from(document.querySelectorAll('span')).filter(el => /MP4|哔哩哔哩/.test(el.textContent)).map(el => el.textContent.trim())
    }""")
    log(f"[{browser_label}] 影片列表源标签: {tags}")
    await page.locator('button[title="播放"]').last.click()

    # 等待 MP4 实际加载
    ready = await wait_for_video_ready(page, timeout=30000)
    log(f"[{browser_label}] MP4 视频加载 readyState>=3: {ready}")
    if not ready:
        log(f"[{browser_label}] 警告: MP4 未成功加载，但继续验证 UI 状态")

    await wait_for_no_resolving_overlay(page, timeout=15000)

    # 5. 验证底栏自动隐藏与隐藏按钮
    log(f"[{browser_label}] 验证控制栏自动隐藏")
    # 先移出播放器区域，再移入以触发 mouseenter
    await page.mouse.move(50, 400)
    await asyncio.sleep(0.2)
    await page.mouse.move(700, 400)
    await asyncio.sleep(0.5)
    await asyncio.sleep(3.5)
    hidden1 = not await controls_visible(page)
    log(f"[{browser_label}] 静止 3 秒后控制栏隐藏: {hidden1}")
    await page.mouse.move(701, 401)
    await asyncio.sleep(0.5)
    visible1 = await controls_visible(page)
    log(f"[{browser_label}] 移动鼠标后控制栏恢复: {visible1}")
    await page.screenshot(path=SCREENSHOT_DIR / f"player-controls-hidden-verification-{suffix}.png")
    log(f"[{browser_label}] 底栏隐藏状态截图已保存")

    # 确保控制栏显示后再点击隐藏按钮
    await page.mouse.move(702, 402)
    await asyncio.sleep(0.3)
    await page.click('button[aria-label="隐藏控制栏"]')
    await asyncio.sleep(1.0)
    hidden2 = not await controls_visible(page)
    log(f"[{browser_label}] 点击隐藏按钮后控制栏隐藏: {hidden2}")
    await page.mouse.move(703, 403)
    await asyncio.sleep(0.5)
    visible2 = await controls_visible(page)
    log(f"[{browser_label}] 再次移动鼠标后控制栏恢复: {visible2}")
    results["auto_hide"] = hidden1 and visible1
    results["hide_button"] = hidden2 and visible2

    # 6. 验证网页全屏
    log(f"[{browser_label}] 验证网页全屏")
    await page.mouse.move(704, 404)
    await asyncio.sleep(0.5)
    web_fs_btn = page.locator('button[aria-label="隐藏控制栏"] + button')
    await web_fs_btn.click()
    await asyncio.sleep(0.6)
    fs = await video_container_fullscreen(page)
    log(f"[{browser_label}] 网页全屏铺满: {fs}")
    await page.screenshot(path=SCREENSHOT_DIR / f"web-fullscreen-verification-{suffix}.png")
    log(f"[{browser_label}] 网页全屏截图已保存")

    await page.mouse.move(705, 405)
    await asyncio.sleep(0.5)
    await web_fs_btn.click()
    await asyncio.sleep(0.6)
    not_fs = not await video_container_fullscreen(page)
    log(f"[{browser_label}] 退出网页全屏后恢复原始布局: {not_fs}")
    results["web_fullscreen"] = fs and not_fs

    await browser.close()
    return results


async def run():
    async with async_playwright() as p:
        # Chromium 验证
        chromium_results = await run_browser(p, "chromium")

        # Firefox 验证（如果可用）
        firefox_results = None
        try:
            firefox_results = await run_browser(p, "firefox")
        except Exception as e:
            log(f"Firefox 验证失败: {e}")

    results = {
        "chromium": chromium_results,
        "firefox": firefox_results,
    }

    log("=" * 50)
    log("Chromium 结果:")
    for k, v in chromium_results.items():
        log(f"  {k}: {v}")
    if firefox_results:
        log("Firefox 结果:")
        for k, v in firefox_results.items():
            log(f"  {k}: {v}")
    else:
        log("Firefox 结果: 未获取")
    log("=" * 50)
    log(f"截图目录: {SCREENSHOT_DIR}")
    return results


if __name__ == "__main__":
    try:
        results = asyncio.run(run())
        chromium_pass = all(
            v for k, v in results["chromium"].items() if isinstance(v, bool)
        )
        firefox_results = results.get("firefox")
        firefox_pass = (
            all(v for k, v in firefox_results.items() if isinstance(v, bool))
            if firefox_results
            else False
        )
        log(f"Chromium 全部通过: {chromium_pass}")
        log(f"Firefox 全部通过: {firefox_pass}")
        sys.exit(0 if chromium_pass else 1)
    except Exception as e:
        log(f"验证失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
