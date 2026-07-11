import asyncio
import json
import re
import sys
import urllib.request
from playwright.async_api import async_playwright

BASE_URL = "http://localhost:5174"
WEBDAV_URL = "http://127.0.0.1:8081"
FTP_HOST = "127.0.0.1"
FTP_PORT = "2121"
VIDEO_PATH = "/test-video.mp4"
OPENLIST_URL = "http://localhost:8080/openlist.json"


def log(msg: str):
    print(f"[TEST] {msg}", flush=True)


def get_token() -> str:
    req = urllib.request.Request(
        "http://localhost:3000/api/auth/login",
        data=json.dumps({"username": "root", "password": "root"}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        data = json.loads(res.read().decode("utf-8"))
        return data["accessToken"]


async def wait_for_message(page, text: str, timeout: int = 10000):
    """等待页面中出现包含指定文本的元素（消息提示）。"""
    await page.wait_for_selector(f"text={text}", timeout=timeout)


async def run():
    token = get_token()
    log("获取登录 token 成功")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()

        # 通过 localStorage 注入登录态，避免自动登录逻辑干扰
        auth_state = {
            "state": {
                "accessToken": token,
                "refreshToken": "",
                "user": {"id": "1", "username": "root", "role": "admin"},
                "isAuthenticated": True,
                "hasLoggedOut": False,
            },
            "version": 0,
        }
        await page.goto(BASE_URL)
        await page.evaluate(
            f"() => {{ localStorage.setItem('zcontrol-auth-storage', JSON.stringify({json.dumps(auth_state)})); }}"
        )

        # 1. 进入首页并创建一起看房间
        log("进入首页")
        await page.goto(f"{BASE_URL}/")
        await asyncio.sleep(2)
        await page.click('button:has-text("开始共享")')
        log("进入创建房间页")
        await page.wait_for_selector('text=一起看', timeout=10000)
        log("选择一起看模式")
        await page.click('text=一起看')
        await page.click('button:has-text("创建房间")')
        await page.wait_for_url(re.compile(r"/room/"), timeout=10000)
        room_url = page.url
        log(f"房间创建成功: {room_url}")

        # 等待 MoviePushPanel 渲染
        await page.wait_for_selector('text=添加影片', timeout=10000)

        # 2. 添加 WebDAV 影片
        log("添加 WebDAV 影片")
        # 源类型下拉框（第一个 select）
        selects = page.locator('select')
        await selects.nth(0).select_option('webdav')
        await page.fill('input[placeholder*="服务器地址"]', WEBDAV_URL)
        await page.fill('input[placeholder*="文件路径"]', VIDEO_PATH)
        await page.click('button:has-text("解析")')
        await page.click('button:has-text("添加")')
        await wait_for_message(page, "影片已添加")
        log("WebDAV 影片添加成功")

        # 3. 添加 FTP 影片
        log("添加 FTP 影片")
        await selects.nth(0).select_option('ftp')
        await page.fill('input[placeholder*="FTP 服务器地址"]', FTP_HOST)
        # 端口是 type="number" 的 input
        await page.locator('input[type="number"]').fill(FTP_PORT)
        await page.fill('input[placeholder*="文件路径"]', VIDEO_PATH)
        await page.click('button:has-text("解析")')
        await page.click('button:has-text("添加")')
        await wait_for_message(page, "影片已添加")
        log("FTP 影片添加成功")

        # 4. 添加 OpenList 影片
        log("添加 OpenList 影片")
        await selects.nth(0).select_option('openlist')
        await page.fill('input[placeholder*="OpenList 索引 URL"]', OPENLIST_URL)
        await page.click('button:has-text("解析")')
        # 等待下拉框出现并选择第一个条目
        await page.wait_for_selector('select:has-text("本地测试视频")', timeout=10000)
        await page.select_option('select:has-text("本地测试视频")', 'http://localhost:8080/test-video.mp4')
        await page.click('button:has-text("添加")')
        await wait_for_message(page, "影片已添加")
        log("OpenList 影片添加成功")

        # 5. 验证影片列表标签
        log("验证影片列表标签")
        await page.wait_for_selector('text=WebDAV', timeout=5000)
        await page.wait_for_selector('text=FTP', timeout=5000)
        await page.wait_for_selector('text=OpenList', timeout=5000)
        log("影片列表标签正确")

        # 6. 依次播放三种源并验证视频加载
        video_selector = 'video'
        for label in ["WebDAV", "FTP", "OpenList"]:
            log(f"播放 {label} 影片")
            # 找到对应影片卡片并点击播放按钮
            card = page.locator('.grid', has_text=label).first
            await card.locator('button[title="播放"]').click()
            # 等待视频元素出现并加载
            await page.wait_for_selector(video_selector, timeout=10000)
            video = page.locator(video_selector).first
            # 等待视频可以播放
            await video.wait_for_function("el => el.readyState >= 3", timeout=20000)
            current_src = await video.evaluate("el => el.currentSrc")
            log(f"{label} 视频 currentSrc: {current_src}")
            # 暂停一会儿再切换下一部
            await asyncio.sleep(3)

        log("所有源播放验证通过")
        await browser.close()
        return True


if __name__ == "__main__":
    try:
        ok = asyncio.run(run())
        sys.exit(0 if ok else 1)
    except Exception as e:
        log(f"测试失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
