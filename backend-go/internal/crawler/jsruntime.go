package crawler

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/eventloop"
)

// goja 运行时：顶替 Python 版依赖的本机 Node.js（scripts.py + js_runner.js）。
//
// 规则脚本是站点管理员写的、可信的，所以允许 fetch 与任意 JS，但跑在独立
// 的 runtime 里，超时用 Interrupt 硬中断。沙箱全局按 js_runner.js 对齐：
// input/ctx 是整份 payload，其它键（keyword/site/html/url/rule/account）平铺，
// 外加 fetch / URL / URLSearchParams / TextEncoder / TextDecoder / atob / btoa /
// setTimeout / clearTimeout / console。
//
// 与 Node 的已知差异（都不影响现有规则写法）：
//   - 没有 Buffer / process / require / crypto；
//   - fetch 只实现 method/headers/body，response 只有 status/ok/url/headers/text()/json()；
//   - 不是 V8：Intl、structuredClone、正则后行断言不可用。

// JSTimeoutError 表示脚本被中断（超时或主动取消）。
var JSTimeoutError = errors.New("脚本执行超时")

// gojaRunner 实现 JSRunner。
type gojaRunner struct {
	fetcher *Fetcher
}

// NewJSRunner 构造脚本运行时。fetcher 为 nil 时用默认抓取器。
func NewJSRunner(fetcher *Fetcher) JSRunner {
	if fetcher == nil {
		fetcher = NewFetcher(FetcherOptions{Timeout: 20 * time.Second, Retries: 0})
	}
	return &gojaRunner{fetcher: fetcher}
}

// Available 恒为 true：goja 随二进制编译，不需要外部解释器。
func (r *gojaRunner) Available() bool { return true }

// logCollector 收集 console 输出，按出现顺序返回。
type logCollector struct {
	mu   sync.Mutex
	rows []string
}

func (l *logCollector) add(vm *goja.Runtime, args []goja.Value) {
	parts := make([]string, 0, len(args))
	for _, arg := range args {
		parts = append(parts, jsStringify(vm, arg))
	}
	l.mu.Lock()
	l.rows = append(l.rows, strings.Join(parts, " "))
	l.mu.Unlock()
}

func (l *logCollector) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, len(l.rows))
	copy(out, l.rows)
	return out
}

// jsStringify 等价 js_runner.js 里 console 的拼串规则：字符串原样，其它走 JSON。
func jsStringify(vm *goja.Runtime, value goja.Value) string {
	if value == nil || goja.IsUndefined(value) || goja.IsNull(value) {
		return ""
	}
	if text, ok := value.Export().(string); ok {
		return text
	}
	if encoded, err := json.Marshal(value.Export()); err == nil {
		return string(encoded)
	}
	return fmt.Sprint(value.Export())
}

// Run 执行一段规则脚本，返回 {ok, result, logs} 或 {ok:false, error, logs}。
func (r *gojaRunner) Run(source string, payload map[string]any, timeoutSec float64) (map[string]any, error) {
	if strings.TrimSpace(source) == "" {
		return map[string]any{"ok": false, "error": "脚本内容为空", "logs": []string{}}, nil
	}
	timeout := time.Duration(timeoutSec * float64(time.Second))
	if timeout <= 0 {
		timeout = 20 * time.Second
	}

	loop := eventloop.NewEventLoop()
	logs := &logCollector{}
	done := make(chan map[string]any, 1)

	finish := func(result map[string]any) {
		result["logs"] = logs.snapshot()
		select {
		case done <- result:
		default: // 已经有结论（例如超时先触发），忽略后到的
		}
	}

	loop.Start()
	defer loop.Stop()

	// 兜底超时：脚本可能卡在永不 settle 的 Promise 上，Interrupt 对这种情况无效。
	// vmRef 保存运行时引用，供超时从中断它。
	// 关键：Interrupt 必须**直接**调用，不能 loop.RunOnLoop 投递——loop 正卡在
	// 用户脚本里（while(true)），投递的回调排在它后面永远轮不到，defer loop.Stop()
	// 就会一直等，整个 Run 死锁。goja 的 Interrupt 本身是跨 goroutine 安全的。
	var vmMu sync.Mutex
	var vmRef *goja.Runtime

	timer := time.AfterFunc(timeout, func() {
		finish(map[string]any{"ok": false, "error": JSTimeoutError.Error()})
		vmMu.Lock()
		target := vmRef
		vmMu.Unlock()
		if target != nil {
			target.Interrupt(JSTimeoutError.Error())
			return
		}
		// 回调还没开始跑（极少见）：此时 loop 空闲，投递能让它立刻执行到中断。
		loop.RunOnLoop(func(vm *goja.Runtime) {
			vm.Interrupt(JSTimeoutError.Error())
		})
	})
	defer timer.Stop()

	loop.RunOnLoop(func(vm *goja.Runtime) {
		vmMu.Lock()
		vmRef = vm
		vmMu.Unlock()
		r.installGlobals(vm, loop, payload, logs)
		// __done 由 Go 侧注入，脚本结束时调用；保证只结算一次。
		_ = vm.Set("__done", func(call goja.FunctionCall) goja.Value {
			value := call.Argument(0)
			if goja.IsUndefined(value) || goja.IsNull(value) {
				finish(map[string]any{"ok": false, "error": "脚本没有返回值"})
				return goja.Undefined()
			}
			object, ok := value.Export().(map[string]any)
			if !ok {
				finish(map[string]any{"ok": false, "error": "脚本输出格式不正确"})
				return goja.Undefined()
			}
			finish(object)
			return goja.Undefined()
		})

		wrapped := buildWrappedScript(source)
		if _, err := vm.RunString(wrapped); err != nil {
			finish(map[string]any{"ok": false, "error": jsErrorText(err)})
		}
	})

	select {
	case result := <-done:
		return result, nil
	case <-time.After(timeout + 2*time.Second):
		return map[string]any{"ok": false, "error": JSTimeoutError.Error(), "logs": logs.snapshot()}, nil
	}
}

// buildWrappedScript 把用户脚本包成 async IIFE，统一走 __done 回报。
//
// 与 js_runner.js 的差别：那边是 `await script()` 后 emit 结果；这里把
// 语法错误也变成 {ok:false}，让上层只处理一种形状。
func buildWrappedScript(source string) string {
	return "(async () => {\n" +
		"try {\n" +
		"const __result = await (async () => {\n" + source + "\n})();\n" +
		"__done({ ok: true, result: __result === undefined ? null : __result });\n" +
		"} catch (__err) {\n" +
		"__done({ ok: false, error: String(__err && __err.stack ? __err.stack : __err) });\n" +
		"}\n" +
		"})();"
}

func jsErrorText(err error) string {
	if err == nil {
		return ""
	}
	var interrupted *goja.InterruptedError
	if errors.As(err, &interrupted) {
		return JSTimeoutError.Error()
	}
	return err.Error()
}

// installGlobals 注册沙箱全局。与 js_runner.js 的 sandbox 一一对应。
func (r *gojaRunner) installGlobals(vm *goja.Runtime, loop *eventloop.EventLoop, payload map[string]any, logs *logCollector) {
	for key, value := range payload {
		_ = vm.Set(key, value)
	}
	_ = vm.Set("input", payload)
	_ = vm.Set("ctx", payload)
	_ = vm.Set("globalThis", vm.GlobalObject())

	console := vm.NewObject()
	logFn := func(call goja.FunctionCall) goja.Value {
		logs.add(vm, call.Arguments)
		return goja.Undefined()
	}
	_ = console.Set("log", logFn)
	_ = console.Set("info", logFn)
	_ = console.Set("warn", logFn)
	_ = console.Set("error", logFn)
	_ = vm.Set("console", console)

	_ = vm.Set("atob", func(call goja.FunctionCall) goja.Value {
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(call.Argument(0).String()))
		if err != nil {
			panic(vm.NewGoError(err))
		}
		return vm.ToValue(string(raw))
	})
	_ = vm.Set("btoa", func(call goja.FunctionCall) goja.Value {
		return vm.ToValue(base64.StdEncoding.EncodeToString([]byte(call.Argument(0).String())))
	})

	installURL(vm)
	installTextCodec(vm)
	installTimers(vm, loop)
	installFetch(vm, loop, r.fetcher)
}

// installURL 用 net/url 实现 URL 与 URLSearchParams（goja 没有这两个全局）。
func installURL(vm *goja.Runtime) {
	_ = vm.Set("URLSearchParams", func(call goja.ConstructorCall) *goja.Object {
		values := url.Values{}
		init := call.Argument(0)
		if !goja.IsUndefined(init) && !goja.IsNull(init) {
			switch typed := init.Export().(type) {
			case string:
				if parsed, err := url.ParseQuery(strings.TrimPrefix(typed, "?")); err == nil {
					values = parsed
				}
			case map[string]any:
				for key, value := range typed {
					values.Set(key, fmt.Sprint(value))
				}
			}
		}
		target := call.This
		_ = target.Set("get", func(name string) goja.Value {
			if items := values[name]; len(items) > 0 {
				return vm.ToValue(items[0])
			}
			return goja.Null()
		})
		_ = target.Set("getAll", func(name string) goja.Value {
			items := values[name]
			if items == nil {
				items = []string{}
			}
			return vm.ToValue(items)
		})
		_ = target.Set("has", func(name string) goja.Value { return vm.ToValue(values.Has(name)) })
		_ = target.Set("set", func(call goja.FunctionCall) goja.Value {
			values.Set(call.Argument(0).String(), call.Argument(1).String())
			return goja.Undefined()
		})
		_ = target.Set("append", func(call goja.FunctionCall) goja.Value {
			values.Add(call.Argument(0).String(), call.Argument(1).String())
			return goja.Undefined()
		})
		_ = target.Set("delete", func(name string) goja.Value {
			values.Del(name)
			return goja.Undefined()
		})
		_ = target.Set("toString", func(goja.FunctionCall) goja.Value { return vm.ToValue(values.Encode()) })
		_ = target.Set("keys", func(goja.FunctionCall) goja.Value {
			keys := make([]string, 0, len(values))
			for key := range values {
				keys = append(keys, key)
			}
			return vm.ToValue(keys)
		})
		return nil
	})

	_ = vm.Set("URL", func(call goja.ConstructorCall) *goja.Object {
		raw := call.Argument(0).String()
		var parsed *url.URL
		if len(call.Arguments) > 1 {
			base, baseErr := url.Parse(call.Argument(1).String())
			ref, refErr := url.Parse(raw)
			if baseErr != nil || refErr != nil {
				panic(vm.NewTypeError("Invalid URL"))
			}
			parsed = base.ResolveReference(ref)
		} else {
			value, err := url.Parse(raw)
			if err != nil {
				panic(vm.NewTypeError("Invalid URL"))
			}
			parsed = value
		}
		target := call.This
		_ = target.Set("href", parsed.String())
		_ = target.Set("origin", parsed.Scheme+"://"+parsed.Host)
		_ = target.Set("protocol", parsed.Scheme+":")
		_ = target.Set("host", parsed.Host)
		_ = target.Set("hostname", parsed.Hostname())
		_ = target.Set("port", parsed.Port())
		_ = target.Set("pathname", parsed.Path)
		_ = target.Set("search", withPrefix(parsed.RawQuery, "?"))
		_ = target.Set("hash", withPrefix(parsed.Fragment, "#"))
		paramsCtor, _ := goja.AssertConstructor(vm.Get("URLSearchParams"))
		if paramsCtor != nil {
			params, ctorErr := paramsCtor(nil, vm.ToValue(parsed.RawQuery))
			if ctorErr == nil {
				_ = target.Set("searchParams", params)
			}
		}
		_ = target.Set("toString", func(goja.FunctionCall) goja.Value { return vm.ToValue(parsed.String()) })
		return nil
	})
}

func withPrefix(value, prefix string) string {
	if value == "" {
		return ""
	}
	return prefix + value
}

// installTextCodec 提供 TextEncoder / TextDecoder 的最小实现（UTF-8）。
func installTextCodec(vm *goja.Runtime) {
	_ = vm.Set("TextEncoder", func(call goja.ConstructorCall) *goja.Object {
		target := call.This
		_ = target.Set("encoding", "utf-8")
		_ = target.Set("encode", func(text string) goja.Value {
			bytes := []byte(text)
			values := make([]any, len(bytes))
			for index, item := range bytes {
				values[index] = int64(item)
			}
			return vm.ToValue(values)
		})
		return nil
	})
	_ = vm.Set("TextDecoder", func(call goja.ConstructorCall) *goja.Object {
		target := call.This
		_ = target.Set("encoding", "utf-8")
		_ = target.Set("decode", func(call goja.FunctionCall) goja.Value {
			input := call.Argument(0)
			switch typed := input.Export().(type) {
			case string:
				return vm.ToValue(typed)
			case []byte:
				return vm.ToValue(string(typed))
			}
			// 数组 / Uint8Array 都按数字序列处理。
			items, ok := input.Export().([]any)
			if !ok {
				object := input.ToObject(vm)
				length := int(object.Get("length").ToInteger())
				items = make([]any, 0, length)
				for index := 0; index < length; index++ {
					items = append(items, object.Get(strconv.Itoa(index)))
				}
			}
			bytes := make([]byte, 0, len(items))
			for _, item := range items {
				bytes = append(bytes, byte(toFloat(item)))
			}
			if !utf8.Valid(bytes) {
				bytes = []byte(strings.ToValidUTF8(string(bytes), "\uFFFD"))
			}
			return vm.ToValue(string(bytes))
		})
		return nil
	})
}

// installTimers 用 time.AfterFunc + RunOnLoop 模拟 setTimeout。
func installTimers(vm *goja.Runtime, loop *eventloop.EventLoop) {
	timers := map[int64]*time.Timer{}
	var sequence int64

	_ = vm.Set("setTimeout", func(call goja.FunctionCall) goja.Value {
		callback, ok := goja.AssertFunction(call.Argument(0))
		if !ok {
			panic(vm.NewTypeError("setTimeout 需要函数"))
		}
		delay := time.Duration(toFloat(call.Argument(1).Export()) * float64(time.Millisecond))
		if delay < 0 {
			delay = 0
		}
		sequence++
		id := sequence
		timers[id] = time.AfterFunc(delay, func() {
			loop.RunOnLoop(func(vm *goja.Runtime) {
				if _, alive := timers[id]; !alive {
					return
				}
				delete(timers, id)
				_, _ = callback(goja.Undefined())
			})
		})
		return vm.ToValue(id)
	})
	_ = vm.Set("clearTimeout", func(id int64) {
		if timer, ok := timers[id]; ok {
			timer.Stop()
			delete(timers, id)
		}
	})
}

// installFetch 把 fetch 映射到 Go 的 Fetcher，response 形状对齐 Node 的常见用法。
func installFetch(vm *goja.Runtime, loop *eventloop.EventLoop, fetcher *Fetcher) {
	_ = vm.Set("fetch", func(call goja.FunctionCall) goja.Value {
		target := call.Argument(0).String()
		options := map[string]any{}
		if init := call.Argument(1); !goja.IsUndefined(init) && !goja.IsNull(init) {
			if exported, ok := init.Export().(map[string]any); ok {
				options = exported
			}
		}
		// method 可能没写，不能直接 fmt.Sprint(nil)（会得到 "<NIL>" 这个非法方法名）。
		method := ""
		if raw, ok := options["method"]; ok && raw != nil {
			method = fmt.Sprint(raw)
		}
		headers := stringifyHeaders(options["headers"])
		body := scriptBody(options["body"])
		promise, resolve, reject := vm.NewPromise()
		go func() {
			response, err := fetcher.Fetch(nil, Request{
				URL:     target,
				Method:  method,
				Headers: headers,
				Body:    body,
			})
			loop.RunOnLoop(func(vm *goja.Runtime) {
				if err != nil {
					_ = reject(err.Error())
					return
				}
				_ = resolve(buildResponse(vm, response))
			})
		}()
		return vm.ToValue(promise)
	})
}

// stringifyHeaders 接受对象或 Headers 形状，转成 map[string]string。
func stringifyHeaders(value any) map[string]string {
	out := map[string]string{}
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			out[key] = fmt.Sprint(item)
		}
	case map[string]string:
		for key, item := range typed {
			out[key] = item
		}
	}
	return out
}

// buildResponse 构造 fetch 的返回值：status/ok/url/headers/text()/json()。
func buildResponse(vm *goja.Runtime, response *FetchResult) map[string]any {
	headers := make(map[string]any, 2)
	headers["get"] = func(name string) goja.Value {
		if value, ok := response.Headers[strings.ToLower(strings.TrimSpace(name))]; ok {
			return vm.ToValue(value)
		}
		return goja.Null()
	}
	headers["has"] = func(name string) goja.Value {
		_, ok := response.Headers[strings.ToLower(strings.TrimSpace(name))]
		return vm.ToValue(ok)
	}
	text := response.Text
	jsonFn := func(goja.FunctionCall) goja.Value {
		promise, resolve, reject := vm.NewPromise()
		var decoded any
		decoder := json.NewDecoder(strings.NewReader(text))
		decoder.UseNumber()
		if err := decoder.Decode(&decoded); err != nil {
			_ = reject("JSON 解析失败: " + err.Error())
			return vm.ToValue(promise)
		}
		_ = resolve(decoded)
		return vm.ToValue(promise)
	}
	return map[string]any{
		"status":     response.Status,
		"statusText": http.StatusText(response.Status),
		"ok":         response.Status >= 200 && response.Status < 300,
		"url":        response.URL,
		"headers":    headers,
		"text": func(goja.FunctionCall) goja.Value {
			promise, resolve, _ := vm.NewPromise()
			_ = resolve(text)
			return vm.ToValue(promise)
		},
		"json": jsonFn,
	}
}
