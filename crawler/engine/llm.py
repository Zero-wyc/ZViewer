"""Minimal OpenAI-compatible chat client (function calling included)."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Optional

from .errors import LLMError


class LLMClient:
    def __init__(self, config: dict):
        llm = config.get("llm") or {}
        self.base_url = (llm.get("base_url") or "https://api.deepseek.com/v1").rstrip("/")
        self.api_key = llm.get("api_key") or ""
        self.model = llm.get("model") or "deepseek-chat"
        self.temperature = float(llm.get("temperature", 0.1))
        self.max_tokens = int(llm.get("max_tokens", 2048))
        self.timeout = float(llm.get("timeout_sec", 90))
        self.reasoning_effort = str(llm.get("reasoning_effort") or "").strip()

    @property
    def api_base(self) -> str:
        base = self.base_url
        if base.endswith("/chat/completions"):
            base = base[: -len("/chat/completions")]
        return base

    @property
    def endpoint(self) -> str:
        return self.api_base + "/chat/completions"

    def list_models(self, api_key: Optional[str] = None, base_url: Optional[str] = None) -> dict:
        """调用 OpenAI 兼容的 GET /models，返回可用模型 id 列表。

        GUI 在用户填完 API Key 后自动调用；base_url / api_key 可以临时覆盖
        当前配置，这样还没保存也能先拉取模型。
        """
        key = (api_key if api_key is not None else self.api_key) or ""
        if not key:
            raise LLMError("请先填写大模型 API Key")
        base = (base_url if base_url is not None else self.api_base) or ""
        base = base.strip().rstrip("/")
        if base.endswith("/chat/completions"):
            base = base[: -len("/chat/completions")]
        endpoint = base + "/models"
        request = urllib.request.Request(endpoint, method="GET")
        request.add_header("Authorization", "Bearer " + key)
        try:
            with urllib.request.urlopen(request, timeout=min(self.timeout, 30.0)) as response:
                body = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            snippet = ""
            try:
                snippet = exc.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            raise LLMError("获取模型列表失败 HTTP %s: %s" % (exc.code, snippet)) from exc
        except urllib.error.URLError as exc:
            raise LLMError("连接模型列表接口失败: %s" % getattr(exc, "reason", exc)) from exc
        except TimeoutError as exc:
            raise LLMError("获取模型列表超时") from exc
        try:
            parsed = json.loads(body)
        except ValueError as exc:
            raise LLMError("模型列表返回的不是 JSON: %s" % body[:200]) from exc
        raw_items = parsed.get("data") if isinstance(parsed, dict) else parsed
        if not isinstance(raw_items, list):
            raise LLMError("模型列表格式不正确", {"raw": parsed})
        models = []
        seen = set()
        for item in raw_items:
            if isinstance(item, str):
                model_id, owner = item, ""
            elif isinstance(item, dict):
                model_id = str(item.get("id") or item.get("name") or "")
                owner = str(item.get("owned_by") or item.get("ownedBy") or "")
            else:
                continue
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            models.append({"id": model_id, "ownedBy": owner})
        models.sort(key=lambda item: item["id"])
        return {"success": True, "models": models, "count": len(models), "baseUrl": base}

    def _resolve_model(self, model: Optional[str] = None) -> str:
        """返回本次请求要使用的模型名；空值回退到配置里的默认模型。"""
        chosen = str(model or "").strip()
        return chosen or self.model

    def chat_stream(
        self,
        messages: list,
        tools: Optional[list] = None,
        tool_choice: str = "auto",
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        response_format: Optional[dict] = None,
        reasoning_effort: Optional[str] = None,
        model: Optional[str] = None,
        on_delta=None,
        cancel=None,
    ) -> dict:
        """流式对话：逐段回调 reasoning/content，结束返回与非流式相同的结构。

        on_delta(kind, text)：kind 为 "reasoning" 或 "content"。
        服务端不支持 stream 时自动回退到 chat()。
        """
        if not self.api_key:
            raise LLMError("尚未配置大模型 API Key，请在 GUI 的爬虫引擎页填写")
        payload = {
            "model": self._resolve_model(model),
            "messages": messages,
            "temperature": self.temperature if temperature is None else temperature,
            "max_tokens": self.max_tokens if max_tokens is None else max_tokens,
            "stream": True,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice
        if response_format:
            payload["response_format"] = response_format
        effort = self.reasoning_effort if reasoning_effort is None else str(reasoning_effort)
        effort = (effort or "").strip()
        if effort and effort != "default":
            payload["reasoning_effort"] = effort
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.endpoint, data=data, method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "text/event-stream")
        request.add_header("Authorization", "Bearer " + self.api_key)

        content_parts: list = []
        reasoning_parts: list = []
        calls: dict = {}
        finish_reason = None
        usage: dict = {}
        emitted = False
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                for raw_line in response:
                    if cancel is not None and cancel():
                        raise LLMError("已停止生成", {"cancelled": True})
                    line = raw_line.decode("utf-8", "replace").strip()
                    if not line or not line.startswith("data:"):
                        continue
                    chunk = line[5:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        parsed = json.loads(chunk)
                    except ValueError:
                        continue
                    if isinstance(parsed, dict) and parsed.get("usage"):
                        usage = parsed.get("usage") or usage
                    choices = parsed.get("choices") if isinstance(parsed, dict) else None
                    if not choices:
                        continue
                    choice = choices[0] or {}
                    if choice.get("finish_reason"):
                        finish_reason = choice.get("finish_reason")
                    delta = choice.get("delta") or {}
                    if not isinstance(delta, dict):
                        continue
                    reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                    if isinstance(reasoning, str) and reasoning:
                        reasoning_parts.append(reasoning)
                        emitted = True
                        if on_delta is not None:
                            on_delta("reasoning", reasoning)
                    piece = delta.get("content")
                    if isinstance(piece, str) and piece:
                        content_parts.append(piece)
                        emitted = True
                        if on_delta is not None:
                            on_delta("content", piece)
                    for item in delta.get("tool_calls") or []:
                        if not isinstance(item, dict):
                            continue
                        index = int(item.get("index") or 0)
                        slot = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                        function = item.get("function") or {}
                        if item.get("id"):
                            slot["id"] = item["id"]
                        if function.get("name"):
                            slot["name"] += function["name"]
                        if function.get("arguments"):
                            slot["arguments"] += function["arguments"]
                        emitted = True
        except LLMError:
            if not emitted:
                return self.chat(
                    messages, tools=tools, tool_choice=tool_choice, temperature=temperature,
                    max_tokens=max_tokens, response_format=response_format,
                    reasoning_effort=reasoning_effort, model=model,
                )
            raise
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            if not emitted:
                return self.chat(
                    messages, tools=tools, tool_choice=tool_choice, temperature=temperature,
                    max_tokens=max_tokens, response_format=response_format,
                    reasoning_effort=reasoning_effort, model=model,
                )
            raise LLMError("流式响应中断: %s" % getattr(exc, "reason", exc)) from exc

        tool_calls = []
        for index in sorted(calls):
            slot = calls[index]
            arguments = slot.get("arguments") or "{}"
            try:
                parsed_args = json.loads(arguments) if isinstance(arguments, str) else arguments
            except ValueError:
                parsed_args = {"__raw": arguments}
            if not isinstance(parsed_args, dict):
                parsed_args = {"value": parsed_args}
            tool_calls.append({
                "id": slot.get("id") or "",
                "name": slot.get("name") or "",
                "arguments": parsed_args,
            })
        return {
            "content": "".join(content_parts),
            "reasoning": "".join(reasoning_parts),
            "toolCalls": tool_calls,
            "finishReason": finish_reason,
            "usage": usage,
        }

    def chat(
        self,
        messages: list,
        tools: Optional[list] = None,
        tool_choice: str = "auto",
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        response_format: Optional[dict] = None,
        reasoning_effort: Optional[str] = None,
        model: Optional[str] = None,
    ) -> dict:
        if not self.api_key:
            raise LLMError("尚未配置大模型 API Key，请在 GUI 的爬虫引擎页填写")
        payload = {
            "model": self._resolve_model(model),
            "messages": messages,
            "temperature": self.temperature if temperature is None else temperature,
            "max_tokens": self.max_tokens if max_tokens is None else max_tokens,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice
        if response_format:
            payload["response_format"] = response_format
        effort = self.reasoning_effort if reasoning_effort is None else str(reasoning_effort)
        effort = (effort or "").strip()
        if effort and effort != "default":
            payload["reasoning_effort"] = effort
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.endpoint, data=data, method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Authorization", "Bearer " + self.api_key)

        last_error: Optional[Exception] = None
        for attempt in range(1, 4):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    body = response.read().decode("utf-8", "replace")
                try:
                    parsed = json.loads(body)
                except ValueError as exc:
                    raise LLMError("大模型返回的不是 JSON: %s" % body[:300]) from exc
                return self._parse_response(parsed)
            except urllib.error.HTTPError as exc:
                snippet = ""
                try:
                    snippet = exc.read().decode("utf-8", "replace")[:500]
                except Exception:
                    pass
                last_error = LLMError("大模型接口 HTTP %s: %s" % (exc.code, snippet))
                if exc.code in (429,) or exc.code >= 500:
                    time.sleep(1.2 * attempt)
                    continue
                raise last_error from exc
            except urllib.error.URLError as exc:
                last_error = LLMError("连接大模型失败: %s" % getattr(exc, "reason", exc))
                time.sleep(1.2 * attempt)
            except TimeoutError as exc:
                last_error = LLMError("大模型请求超时")
                time.sleep(1.2 * attempt)
        raise last_error or LLMError("大模型调用失败")

    @staticmethod
    def _parse_response(data: dict) -> dict:
        choices = data.get("choices") or []
        if not choices:
            raise LLMError("大模型返回缺少 choices", {"raw": data})
        message = choices[0].get("message") or {}
        tool_calls = []
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            arguments = function.get("arguments") or "{}"
            try:
                parsed_args = json.loads(arguments) if isinstance(arguments, str) else arguments
            except ValueError:
                parsed_args = {"__raw": arguments}
            if not isinstance(parsed_args, dict):
                parsed_args = {"value": parsed_args}
            tool_calls.append({
                "id": call.get("id") or "",
                "name": function.get("name") or "",
                "arguments": parsed_args,
            })
        reasoning = message.get("reasoning_content") or message.get("reasoning") or ""
        if isinstance(reasoning, list):
            reasoning = "".join(str(part) for part in reasoning)
        return {
            "content": message.get("content") or "",
            "reasoning": reasoning if isinstance(reasoning, str) else str(reasoning),
            "toolCalls": tool_calls,
            "finishReason": choices[0].get("finish_reason"),
            "usage": data.get("usage") or {},
        }
