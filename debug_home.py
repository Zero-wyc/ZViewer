import asyncio
import json
import urllib.request
from playwright.async_api import async_playwright

BASE_URL = "http://localhost:5174"

def get_token():
    req = urllib.request.Request(
        'http://localhost:3000/api/auth/login',
        data=json.dumps({'username':'root','password':'root'}).encode(),
        headers={'Content-Type':'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())['accessToken']

async def run():
    token = get_token()
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={'width':1280,'height':720})
        payload = {
            "state": {
                "accessToken": token,
                "refreshToken": "",
                "user": {"id":"1","username":"root","role":"root"},
                "isAuthenticated": True,
                "hasLoggedOut": False,
            },
            "version": 0,
        }
        await context.add_init_script(f"() => {{ localStorage.setItem('zcontrol-auth-storage', JSON.stringify({json.dumps(payload)})); }}")
        page = await context.new_page()
        await page.route('**/api/auth/guest', lambda route: route.abort())
        page.on('console', lambda msg: print(f"[CONSOLE] {msg.type}: {msg.text}"))
        page.on('response', lambda resp: print(f"[RESPONSE] {resp.status} {resp.url}") if 'api/auth' in resp.url else None)
        await page.goto(f"{BASE_URL}/", wait_until='networkidle')
        await page.screenshot(path='debug_home.png')
        storage = await page.evaluate("() => localStorage.getItem('zcontrol-auth-storage')")
        print('--- localStorage ---')
        print(storage[:500] if storage else None)
        text = await page.evaluate('() => document.body.innerText')
        html = await page.content()
        print('--- body text ---')
        print(text[:2000])
        print('--- has button ---')
        print('开始共享' in text)
        print('--- html snippet ---')
        print(html[1000:3000])
        await browser.close()

asyncio.run(run())
