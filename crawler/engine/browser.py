"""Off-screen Chromium control over the DevTools protocol (stdlib only).

Two modes share one persistent profile:

* headless - the agent drives pages through CDP (navigate / read DOM / eval).
* visible  - the same profile with a real window, so a human can log in to a
  site; cookies captured from the visible session are stored as an account.

Only one browser process runs at a time because a Chromium profile cannot be
opened twice.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
from http.client import HTTPConnection
from typing import Any
from urllib.parse import quote, urlsplit

from .errors import ConfigError, EngineError


DEFAULT_PORTS = (9333, 9334, 9335)

# 播放地址嗅探：只认常见媒体扩展名或 HLS/DASH 的 MIME。
_MEDIA_URL_RE = re.compile(r"\.(?:m3u8|mp4|flv|m4s|ts|mpd)(?:[?#]|$)", re.I)
_MEDIA_MIME_HINTS = ("mpegurl", "dash+xml", "video/mp4", "video/x-flv", "video/mp2t")


def _looks_like_media(url: str, mime: str = "") -> bool:
    if not url:
        return False
    if _MEDIA_URL_RE.search(_media_path(url)):
        return True
    mime = (mime or "").lower()
    return any(hint in mime for hint in _MEDIA_MIME_HINTS)


def _media_path(url: str) -> str:
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    return parts.path or ""


def _browser_candidates() -> list[str]:
    candidates = []
    env = os.environ.get("CRAWLER_BROWSER_BIN", "").strip()
    if env:
        candidates.append(env)
    for name in ("msedge", "chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            candidates.append(found)
    if os.name == "nt":
        roots = [os.environ.get("PROGRAMFILES(X86)", ""), os.environ.get("PROGRAMFILES", ""),
                 os.environ.get("LOCALAPPDATA", "")]
        rels = [
            r"Microsoft\Edge\Application\msedge.exe",
            r"Google\Chrome\Application\chrome.exe",
            r"Chromium\Application\chrome.exe",
        ]
        for root in roots:
            if not root:
                continue
            for rel in rels:
                path = os.path.join(root, rel)
                if os.path.isfile(path):
                    candidates.append(path)
    else:
        for path in ("/usr/bin/microsoft-edge", "/usr/bin/google-chrome",
                     "/usr/bin/chromium", "/usr/bin/chromium-browser"):
            if os.path.isfile(path):
                candidates.append(path)
    seen = set()
    unique = []
    for item in candidates:
        key = os.path.normcase(os.path.abspath(item))
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def find_browser_bin(configured: str = "") -> str:
    if configured:
        path = configured.strip()
        if os.path.isfile(path):
            return path
        found = shutil.which(path)
        if found:
            return found
        raise ConfigError("找不到浏览器可执行文件: %s" % path)
    candidates = _browser_candidates()
    if not candidates:
        raise ConfigError("找不到 Chromium 内核浏览器（Edge/Chrome），"
                          "可安装或设置 engine.browser.bin")
    return candidates[0]


def _cookie_matches(cookie: dict, site: str) -> bool:
    if not site:
        return True
    site = site.lower().strip().strip(".")
    domain = str(cookie.get("domain", "")).lower().strip().strip(".")
    return bool(domain) and (domain == site or domain.endswith("." + site)
                             or site.endswith("." + domain))


class WebSocket:
    """Minimal RFC 6455 client good enough for CDP text frames."""

    def __init__(self, url: str, timeout: float = 30.0):
        parts = urlsplit(url)
        if parts.scheme != "ws":
            raise EngineError("browser_error", "CDP websocket 地址无效: %s" % url)
        self.host = parts.hostname or "127.0.0.1"
        self.port = parts.port or 80
        self.path = parts.path or "/"
        if parts.query:
            self.path += "?" + parts.query
        self.timeout = timeout
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        self.sock.settimeout(timeout)
        self._closed = False
        self._buffer = b""
        self._handshake()

    def _handshake(self):
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n" % (self.path, self.host, self.port, key)
        )
        self.sock.sendall(request.encode("ascii"))
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EngineError("browser_error", "CDP websocket 握手失败：连接被关闭")
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        status_line = head.split(b"\r\n", 1)[0].decode("latin-1", "replace")
        if " 101 " not in status_line + " ":
            raise EngineError("browser_error", "CDP websocket 握手失败: %s" % status_line)
        self._buffer = rest

    def _read_exact(self, size: int) -> bytes:
        while len(self._buffer) < size:
            chunk = self.sock.recv(max(4096, size - len(self._buffer)))
            if not chunk:
                raise EngineError("browser_error", "CDP websocket 已断开")
            self._buffer += chunk
        data, self._buffer = self._buffer[:size], self._buffer[size:]
        return data

    def send_text(self, text: str):
        payload = text.encode("utf-8")
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _send_control(self, opcode: int, payload: bytes = b""):
        mask = os.urandom(4)
        header = bytes([0x80 | opcode, 0x80 | len(payload)]) + mask
        body = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self.sock.sendall(header + body)

    def recv_text(self) -> str:
        chunks = []
        first = True
        while True:
            first_byte, second = self._read_exact(2)
            fin = bool(first_byte & 0x80)
            opcode = first_byte & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else b""
            payload = self._read_exact(length)
            if masked:
                payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
            if opcode == 0x9:  # ping
                self._send_control(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:
                raise EngineError("browser_error", "CDP websocket 已关闭")
            if opcode in (0x1, 0x2, 0x0):
                chunks.append(payload)
                if fin:
                    return b"".join(chunks).decode("utf-8", "replace")
                first = False
                continue
            raise EngineError("browser_error", "CDP websocket 收到未知帧: opcode=%d" % opcode)

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._send_control(0x8)
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


class CDP:
    def __init__(self, ws_url: str, timeout: float = 30.0):
        self.ws = WebSocket(ws_url, timeout=timeout)
        self._id = 0
        self._lock = threading.RLock()
        self.events: list[dict[str, Any]] = []

    def call(self, method: str, params: dict | None = None, timeout: float | None = None):
        with self._lock:
            self._id += 1
            message_id = self._id
            payload = {"id": message_id, "method": method}
            if params:
                payload["params"] = params
            self.ws.send_text(json.dumps(payload, ensure_ascii=False))
            deadline = time.time() + (timeout or self.ws.timeout)
            while True:
                if time.time() > deadline:
                    raise EngineError("browser_error", "CDP 调用超时: %s" % method)
                raw = self.ws.recv_text()
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if message.get("id") == message_id:
                    if "error" in message:
                        error = message["error"]
                        raise EngineError("browser_error", "CDP %s 失败: %s" % (method, error.get("message", error)))
                    return message.get("result", {})
                if "method" in message:
                    self.events.append(message)
                    if len(self.events) > 500:
                        del self.events[:200]

    def close(self):
        self.ws.close()


class Page:
    def __init__(self, cdp: CDP, target_id: str, url: str = ""):
        self.cdp = cdp
        self.target_id = target_id
        self.url = url
        self._enabled = False

    def _prepare(self):
        if not self._enabled:
            self.cdp.call("Page.enable")
            self.cdp.call("Runtime.enable")
            self.cdp.call("Network.enable")
            self._enabled = True

    def navigate(self, url: str, timeout: float = 25.0) -> dict:
        self._prepare()
        result = self.cdp.call("Page.navigate", {"url": url})
        error = result.get("errorText")
        if error:
            raise EngineError("browser_error", "打开页面失败: %s" % error)
        self.url = url
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                state = self.evaluate("document.readyState", timeout=5)
            except EngineError:
                state = None
            if state == "complete":
                break
            time.sleep(0.15)
        else:
            # Long-polling pages may never fire load; keep whatever rendered.
            time.sleep(0.5)
        return self.info()

    def evaluate(self, expression: str, await_promise: bool = True, timeout: float = 25.0):
        self._prepare()
        result = self.cdp.call("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise,
            "userGesture": True,
        }, timeout=timeout)
        details = result.get("exceptionDetails")
        if details:
            text = details.get("exception", {}).get("description") or details.get("text")
            raise EngineError("browser_error", "页面脚本执行失败: %s" % text)
        return result.get("result", {}).get("value")

    def html(self) -> str:
        return str(self.evaluate("document.documentElement ? document.documentElement.outerHTML : ''") or "")

    def text(self, selector: str = "") -> str:
        if selector:
            script = ("(() => { const el = document.querySelector(%s);"
                      " return el ? (el.innerText || el.textContent || '') : ''; })()"
                      % json.dumps(selector))
        else:
            script = "document.body ? (document.body.innerText || '') : ''"
        return str(self.evaluate(script) or "")

    def info(self) -> dict:
        data = self.evaluate("({title: document.title, url: location.href,"
                             " ready: document.readyState,"
                             " text: (document.body ? (document.body.innerText || '') : '').slice(0, 200)})")
        if not isinstance(data, dict):
            data = {}
        self.url = data.get("url") or self.url
        return {
            "url": self.url,
            "title": str(data.get("title") or ""),
            "ready": str(data.get("ready") or ""),
            "textPreview": str(data.get("text") or ""),
        }

    def collect_media(self, limit: int = 60) -> list[str]:
        """收集页面已加载/正在加载的媒体地址（CDP 网络事件 + Performance 资源）。"""
        self._prepare()
        found: list[str] = []
        seen: set[str] = set()

        def add(url: str, mime: str = "") -> None:
            url = (url or "").strip()
            if not url or url in seen:
                return
            if not _looks_like_media(url, mime):
                return
            seen.add(url)
            found.append(url)

        for event in list(self.cdp.events):
            method = event.get("method") or ""
            params = event.get("params") or {}
            if method == "Network.responseReceived":
                response = params.get("response") or {}
                add(str(response.get("url") or ""), str(response.get("mimeType") or ""))
            elif method == "Network.requestWillBeSent":
                add(str((params.get("request") or {}).get("url") or ""))

        try:
            resources = self.evaluate(
                "performance.getEntriesByType('resource').map(e => e.name)"
            )
            for url in resources or []:
                add(str(url))
        except EngineError:
            pass
        try:
            videos = self.evaluate(
                "Array.from(document.querySelectorAll('video')).map(v => v.currentSrc || v.src || '')"
            )
            for url in videos or []:
                add(str(url))
        except EngineError:
            pass
        return found[:limit]

    def nudge_playback(self) -> bool:
        """尝试触发页面播放（有些站点要点了播放按钮才会请求 m3u8）。"""
        self._prepare()
        script = """(() => {
          const v = document.querySelector('video');
          if (v) {
            try { v.muted = true; } catch (e) {}
            try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
          }
          const sels = ['.vjs-big-play-button', '.dplayer-play-icon',
            '.artplayer-plugin-controls .art-control-play', '.play-btn',
            '.btn-play', 'button[aria-label*="播放"]', 'button[title*="播放"]'];
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el) { try { el.click(); } catch (e) {} break; }
          }
          return true;
        })()"""
        try:
            return bool(self.evaluate(script))
        except EngineError:
            return False

    def cookies(self, site: str = "") -> list[dict]:
        self._prepare()
        result = self.cdp.call("Network.getAllCookies")
        cookies = result.get("cookies", []) or []
        if not site:
            return cookies
        return [cookie for cookie in cookies if _cookie_matches(cookie, site)]

    def screenshot(self, path: str) -> str:
        self._prepare()
        result = self.cdp.call("Page.captureScreenshot", {"format": "png"}, timeout=30)
        data = result.get("data") or ""
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(data))
        return path

    def close(self):
        try:
            self.cdp.close()
        except Exception:
            pass


def _http_json(port: int, path: str, method: str = "GET", timeout: float = 3.0):
    conn = HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(method, path)
        response = conn.getresponse()
        body = response.read()
        return response.status, json.loads(body.decode("utf-8")) if body else None
    finally:
        conn.close()


class BrowserController:
    """Manages one Chromium process plus a CDP page for agent/site control."""

    def __init__(self, config: dict, data_dir: str):
        self.config = config or {}
        self.data_dir = data_dir
        self.profile_dir = self.config.get("profile_dir") or os.path.join(data_dir, "browser-profile")
        self.debug_port = int(self.config.get("debug_port") or 0)
        self.timeout = float(self.config.get("page_timeout_sec") or 25)
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self._pid: int | None = None
        self._edge_log = None
        self._cdp: CDP | None = None
        self._page: Page | None = None
        self._mode = ""
        self._bin = ""
        self._last_error = ""

    # -- process lifecycle -------------------------------------------------
    def bin(self) -> str:
        if not self._bin:
            self._bin = find_browser_bin(str(self.config.get("bin") or ""))
        return self._bin

    def available(self) -> bool:
        try:
            self.bin()
            return True
        except EngineError:
            return False

    def _pick_port(self) -> int:
        candidates = [self.debug_port] if self.debug_port else list(DEFAULT_PORTS)
        for port in candidates:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                    continue
            except OSError:
                return port
        return candidates[0]

    def _alive(self) -> bool:
        if self._proc is not None:
            return self._proc.poll() is None
        pid = self._pid
        if not pid:
            return False
        if os.name != "nt":
            try:
                os.kill(pid, 0)
                return True
            except OSError:
                return False
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x00100000, False, int(pid))  # SYNCHRONIZE
            if not handle:
                return False
            try:
                return kernel32.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return False

    def _port_owner_pids(self, port: int) -> list[int]:
        if os.name != "nt":
            return []
        pids: set[int] = set()
        try:
            out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True,
                                 timeout=10, creationflags=0x08000000).stdout.decode("mbcs", "ignore")
        except Exception:
            return []
        needle = ":%d" % port
        for line in out.splitlines():
            parts = line.split()
            if len(parts) < 5 or parts[0].upper() != "TCP":
                continue
            if not parts[1].endswith(needle):
                continue
            if parts[3].upper() != "LISTENING":
                continue
            try:
                pids.add(int(parts[4]))
            except ValueError:
                continue
        return sorted(pids)

    def _kill_port_owner(self, port: int) -> None:
        for pid in self._port_owner_pids(port):
            try:
                img = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"],
                                     capture_output=True, timeout=10,
                                     creationflags=0x08000000).stdout.decode("mbcs", "ignore")
            except Exception:
                img = ""
            if "msedge.exe" not in img.lower() and "chrome.exe" not in img.lower():
                continue
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=10, creationflags=0x08000000)
            except Exception:
                pass

    TASK_NAME = "ZViewerCrawlerBrowser"

    def _write_launch_bat(self, args: list[str]) -> str:
        bat = os.path.join(os.path.dirname(self.profile_dir), "browser-launch.bat")
        lines = ["@echo off", " ".join('"%s"' % str(a).replace('"', '""') for a in args)]
        with open(bat, "w", encoding="mbcs", errors="replace") as fh:
            fh.write("\r\n".join(lines) + "\r\n")
        return bat

    def _delete_task(self) -> None:
        try:
            subprocess.run(["schtasks", "/Delete", "/TN", self.TASK_NAME, "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=15, creationflags=0x08000000)
        except Exception:
            pass

    def _spawn_detached(self, args: list[str]) -> bool:
        """让浏览器脱离当前进程的作业对象/桌面会话限制。

        引擎由 GUI 壳拉起时，GUI 自己可能处在受限作业对象里；那里直接 Popen 的
        Edge 渲染进程会被挂起（CDP websocket 握手超时）。这里依次尝试：
        1) 计划任务立即运行启动脚本（Task Scheduler 创建进程，天然脱离作业对象）；
        2) WMI Win32_Process.Create（部分受限环境会被拒绝）。
        """
        if os.name != "nt":
            return False
        try:
            bat = self._write_launch_bat(args)
        except Exception as exc:
            self._last_error = "写入浏览器启动脚本失败: %s" % exc
            return False
        self._proc = None
        self._pid = None
        errs: list[str] = []
        try:
            created = subprocess.run(
                ["schtasks", "/Create", "/TN", self.TASK_NAME, "/TR", bat,
                 "/SC", "ONCE", "/ST", "23:59", "/F"],
                capture_output=True, timeout=25, creationflags=0x08000000)
            errs.append("schtasks create rc=%s out=%r" % (created.returncode,
                                                         ((created.stdout or b"") + (created.stderr or b""))[:200]))
            if created.returncode == 0:
                run = subprocess.run(["schtasks", "/Run", "/TN", self.TASK_NAME],
                                     capture_output=True, timeout=25,
                                     creationflags=0x08000000)
                if run.returncode == 0:
                    return True
                errs.append("schtasks run rc=%s out=%r" % (run.returncode,
                                                          ((run.stdout or b"") + (run.stderr or b""))[:200]))
                self._delete_task()
            else:
                self._delete_task()
        except Exception as exc:
            self._last_error = "计划任务启动浏览器失败: %s" % exc
        system_root = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
        candidates = [
            os.path.join(system_root, "System32", "wbem", "WMIC.exe"),
            "wmic",
        ]
        out = b""
        for exe in candidates:
            try:
                proc = subprocess.run(
                    [exe, "process", "call", "create", 'cmd /c "%s"' % bat],
                    capture_output=True, timeout=25, creationflags=0x08000000)
            except Exception as exc:
                errs.append("%s: %s" % (exe, exc))
                continue
            out = (proc.stdout or b"") + (proc.stderr or b"")
            if re.search(rb"ProcessId = (\d+)", out):
                break
            errs.append("%s: rc=%s out=%r" % (exe, proc.returncode, out[:160]))
        match = re.search(rb"ProcessId = (\d+)", out)
        if not match:
            self._last_error = "脱离启动浏览器失败: " + " | ".join(errs)
            return False
        try:
            self._pid = int(match.group(1))
        except ValueError:
            return False
        return True

    def _base_args(self, mode: str) -> list[str]:
        port = self.debug_port or self._pick_port()
        self.debug_port = port
        args = [
            self.bin(),
            "--remote-debugging-port=%d" % port,
            "--user-data-dir=" + os.path.abspath(self.profile_dir),
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--disable-popup-blocking",
            "--disable-features=Translate,OptimizationHints",
            "--window-size=1440,960",
        ]
        if mode == "headless":
            args += ["--headless=new", "--disable-gpu", "--mute-audio",
                     "--no-sandbox", "--disable-dev-shm-usage", "about:blank"]
        else:
            args += ["--new-window", "about:blank"]
        return args

    def _wait_devtools(self, timeout: float = 25.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                continue
            try:
                status, data = _http_json(self.debug_port, "/json/version", timeout=1.0)
                if status == 200 and data:
                    return
            except Exception:
                pass
            time.sleep(0.2)
        raise EngineError("browser_error", "浏览器调试端口未就绪: %d" % self.debug_port)

    def _kill_proc_tree(self) -> None:
        proc = self._proc
        pid = self._pid
        self._proc = None
        self._pid = None
        self._mode = ""
        if proc is None and not pid:
            return
        if os.name == "nt" and pid:
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=10, creationflags=0x08000000)
            except Exception:
                pass
        if proc is None:
            return
        if os.name == "nt":
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=10, creationflags=0x08000000)
            except Exception:
                pass
        if proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            proc.wait(timeout=5)
        except Exception:
            pass

    def _launch(self, mode: str, url: str = "") -> dict:
        self.close()
        os.makedirs(self.profile_dir, exist_ok=True)
        if self.debug_port:
            # 上一个实例可能是脱离作业对象启动、PID 已丢失的孤儿进程，先按端口清掉。
            self._kill_port_owner(self.debug_port)
        last_error: EngineError | None = None
        # 引擎由 GUI 壳拉起时可能和 GUI 一起处在受限作业对象里，那里直接 Popen 的
        # Edge 渲染进程会被挂起（CDP websocket 握手超时）。优先用 WMI 脱离启动；
        # 失败时退回普通 Popen，并重试一次放宽 chromium 沙箱。
        plan = [("popen", 0), ("popen", 1)]
        for launcher, attempt in plan:
            args = self._base_args(mode)
            if attempt and "--no-sandbox" not in args:
                args = args[:1] + ["--no-sandbox", "--disable-gpu"] + args[1:]
            if url:
                args[-1] = url
            if launcher == "detached":
                if not self._spawn_detached(args):
                    continue
            else:
                creationflags = 0
                if os.name == "nt":
                    creationflags = 0x00000008 | 0x08000000  # DETACHED_PROCESS | CREATE_NO_WINDOW
                stdout = subprocess.DEVNULL if mode == "headless" else None
                stderr = subprocess.DEVNULL if mode == "headless" else None
                if mode == "headless":
                    try:
                        log_dir = os.path.join(self.data_dir, "log")
                        os.makedirs(log_dir, exist_ok=True)
                        self._edge_log = open(os.path.join(log_dir, "browser-edge.log"),
                                              "ab", buffering=0)
                        stderr = self._edge_log
                    except Exception:
                        pass
                try:
                    self._proc = subprocess.Popen(args, stdout=stdout, stderr=stderr,
                                                  stdin=subprocess.DEVNULL, creationflags=creationflags)
                except OSError as exc:
                    last_error = EngineError("browser_error", "启动浏览器失败: %s" % exc)
                    self._kill_proc_tree()
                    continue
            self._mode = mode
            try:
                self._wait_devtools()
                if self._pid is None and self._proc is None:
                    owners = self._port_owner_pids(self.debug_port)
                    self._pid = owners[0] if owners else None
                    self._delete_task()  # Edge 已经起来，任务留着只会日后再触发一次
                self._page = self._new_page(url or "about:blank")
                self._last_error = ""
                return self._page.info()
            except EngineError as exc:
                last_error = exc
                self._delete_task()
                try:
                    if self._cdp is not None:
                        self._cdp.close()
                except Exception:
                    pass
                self._cdp = None
                self._page = None
                self._kill_proc_tree()
                continue
        assert last_error is not None
        hint = ("；如果本程序是被某个终端/工具以受限作业对象方式拉起的，"
                "浏览器子进程可能被系统拦截，请改为从桌面正常启动")
        self._last_error = str(last_error)
        raise EngineError("browser_error", "%s%s" % (last_error.message, hint))

    def _new_page(self, url: str) -> Page:
        status, data = _http_json(self.debug_port, "/json/new?" + quote(url, safe=""), method="PUT")
        if status != 200 or not isinstance(data, dict):
            raise EngineError("browser_error", "无法创建浏览器标签页（status=%s）" % status)
        ws_url = data.get("webSocketDebuggerUrl")
        if not ws_url:
            raise EngineError("browser_error", "浏览器未返回调试地址")
        cdp = CDP(ws_url, timeout=max(30.0, self.timeout))
        self._cdp = cdp
        page = Page(cdp, data.get("id", ""), url)
        page.navigate(url, timeout=self.timeout)
        return page

    def ensure(self) -> Page:
        with self._lock:
            if self._page is not None and self._alive():
                # 可见窗口也走同一 CDP，人工登录期间 agent 仍可读页面，不能把它换成无头实例。
                return self._page
            self._launch("headless")
            return self._page

    def _require_page(self) -> Page:
        if self._page is None:
            return self.ensure()
        return self._page

    def status(self) -> dict:
        running = self._alive()
        page = None
        if running and self._page is not None:
            try:
                page = self._page.info()
            except Exception as exc:
                page = {"error": str(exc)}
        return {
            "available": self.available(),
            "bin": self._bin or (self.config.get("bin") or ""),
            "running": running,
            "mode": self._mode if running else "",
            "debugPort": self.debug_port,
            "profileDir": self.profile_dir,
            "page": page,
            "lastError": self._last_error,
        }

    def close(self) -> None:
        with self._lock:
            cdp = self._cdp
            self._cdp = None
            self._page = None
            if cdp is not None:
                try:
                    cdp.call("Browser.close", timeout=3)
                except Exception:
                    pass
                try:
                    cdp.close()
                except Exception:
                    pass
            if self._alive():
                self._kill_proc_tree()
            else:
                self._proc = None
                self._pid = None
                self._mode = ""

    # -- agent-facing operations ------------------------------------------
    def open(self, url: str, wait_sec: float = 0) -> dict:
        with self._lock:
            page = self.ensure()
            info = page.navigate(url, timeout=self.timeout)
            if wait_sec:
                time.sleep(min(float(wait_sec), 10.0))
                info = page.info()
            return info

    def html(self, max_chars: int = 200000) -> dict:
        with self._lock:
            page = self._require_page()
            html = page.html()
            return {"url": page.url, "html": html[:max_chars], "length": len(html)}

    def text(self, selector: str = "", max_chars: int = 20000) -> dict:
        with self._lock:
            page = self._require_page()
            text = page.text(selector)
            return {"url": page.url, "text": text[:max_chars]}

    def evaluate(self, script: str) -> dict:
        with self._lock:
            page = self._require_page()
            value = page.evaluate(script)
            return {"url": page.url, "value": value}

    def collect_media(self, limit: int = 60) -> dict:
        with self._lock:
            page = self._require_page()
            return {"url": page.url, "items": page.collect_media(limit)}

    def nudge_playback(self) -> dict:
        with self._lock:
            page = self._require_page()
            return {"url": page.url, "ok": page.nudge_playback()}

    def click(self, selector: str) -> dict:
        script = ("(() => { const el = document.querySelector(%s);"
                  " if (!el) return {ok:false, reason:'not found'};"
                  " el.scrollIntoView({block:'center'}); el.click();"
                  " return {ok:true, tag: el.tagName, text: (el.innerText || '').slice(0,80)}; })()"
                  % json.dumps(selector))
        with self._lock:
            page = self._require_page()
            return page.evaluate(script)

    def cookie_summary(self, site: str = "") -> dict:
        with self._lock:
            page = self._require_page()
            cookies = [cookie for cookie in page.cookies(site) if _cookie_matches(cookie, site)]
            return {
                "url": page.url,
                "site": site,
                "count": len(cookies),
                "names": sorted({str(c.get("name", "")) for c in cookies if c.get("name")}),
                "domains": sorted({str(c.get("domain", "")) for c in cookies if c.get("domain")}),
            }

    def cookie_header(self, site: str = "") -> str:
        with self._lock:
            page = self._require_page()
            cookies = [cookie for cookie in page.cookies(site) if _cookie_matches(cookie, site)]
            pairs = []
            for cookie in cookies:
                name = str(cookie.get("name", ""))
                if not name:
                    continue
                pairs.append("%s=%s" % (name, cookie.get("value", "")))
            return "; ".join(pairs)

    def screenshot(self) -> str:
        with self._lock:
            page = self._require_page()
            path = os.path.join(self.data_dir, "screenshots", "page-%d.png" % int(time.time() * 1000))
            return page.screenshot(path)

    # -- human login ------------------------------------------------------
    def show(self, url: str = "", wait_sec: float = 0) -> dict:
        """把当前（或指定）页面用一个真实窗口显示出来，让用户人工登录。

        无头与可见模式共用同一个 profile，切换后 Cookie/登录态仍然有效。
        由 agent 在遇到登录墙时调用；登录完成后调用 save_login 保存账号。
        """
        with self._lock:
            target = (url or "").strip()
            if not target and self._page is not None:
                target = self._page.url or "about:blank"
            target = target or "about:blank"
            running = self._alive()
            if running and self._mode == "visible":
                if url:
                    info = self._page.navigate(target, timeout=self.timeout)
                else:
                    info = self._page.info() if self._page is not None else {}
                return {
                    "success": True,
                    "mode": "visible",
                    "page": info,
                    "message": "浏览器窗口已经显示，请在同一窗口里完成登录。",
                }
            try:
                self._launch("visible", target)
            except EngineError as exc:
                self._last_error = str(exc)
                raise
            if wait_sec:
                time.sleep(min(float(wait_sec), 10.0))
            return {
                "success": True,
                "mode": "visible",
                "page": self._page.info() if self._page is not None else {},
                "message": "已显示浏览器窗口，请在该窗口完成登录；登录完成后调用 browser_save_login 保存登录态。",
            }

    def hide(self) -> dict:
        """收起可见窗口，转回后台无头运行（保留当前页面与 profile 登录态）。"""
        with self._lock:
            running = self._alive()
            if not running:
                return {"success": True, "mode": "", "page": None,
                        "message": "浏览器没有在运行。"}
            if self._mode != "visible":
                return {
                    "success": True,
                    "mode": self._mode,
                    "page": self._page.info() if self._page is not None else {},
                    "message": "浏览器本来就在后台运行。",
                }
            url = self._page.url if self._page is not None else "about:blank"
            self._launch("headless", url or "about:blank")
            return {
                "success": True,
                "mode": "headless",
                "page": self._page.info() if self._page is not None else {},
                "message": "已收起浏览器窗口，转回后台无头运行。",
            }

    def open_login(self, url: str) -> dict:
        result = self.show(url)
        return {
            "success": True,
            "status": self.status(),
            "message": result.get("message") or "已打开浏览器窗口，请在该窗口完成登录。",
        }

    def save_login(self, site: str, name: str = "", accounts=None) -> dict:
        site = (site or "").strip().lower()
        if not site:
            raise ConfigError("缺少站点域名")
        if accounts is None:
            raise ConfigError("账号存储不可用")
        with self._lock:
            page = self._require_page()
            cookies = [cookie for cookie in page.cookies(site) if _cookie_matches(cookie, site)]
            if not cookies:
                raise EngineError("browser_error", "没有在 %s 捕获到 Cookie，请确认已在浏览器窗口里登录" % site)
            header = "; ".join("%s=%s" % (str(c.get("name", "")), c.get("value", ""))
                               for c in cookies if c.get("name"))
            user_agent = str(self.config.get("user_agent") or "")
            account = accounts.save({
                "name": name or ("%s 登录" % site),
                "site": site,
                "cookies": header,
                "headers": {"User-Agent": user_agent} if user_agent else {},
                "notes": "由离屏 WebView 人工登录保存",
            })
            public = accounts.public_view(account) if hasattr(accounts, "public_view") else account
            self.close()
            return {"success": True, "account": public,
                    "cookieCount": len(cookies), "site": site}

    def clear_profile(self) -> None:
        with self._lock:
            self.close()
            shutil.rmtree(self.profile_dir, ignore_errors=True)