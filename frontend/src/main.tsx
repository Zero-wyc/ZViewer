import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from '@/components/ThemeProvider'
import { initClientLogger } from '@/lib/clientLogger'
import { installMediaDebugProbe } from '@/lib/media-debug'
import { captureShareBackendFromQuery } from '@/modules/piik-share/backend'
import App from './App'
import './index.css'

// 初始化浏览器控制台日志上报：拦截 console 与未捕获异常，批量发送到后端写入 log/frontend-console.log
initClientLogger({ minLevel: 'debug' })

// 共享链路开关：`?shareBackend=piik` 在这里落到 localStorage，
// 因为 `/share/<id>` 随后会被重定向、query 丢掉。
captureShareBackendFromQuery()

// 媒体元素诊断探针（临时）：localStorage.zviewer-media-debug === '1' 时启用，
// 抓取所有 play/pause/src=/new Audio 的调用堆栈，复现双声后 __mediaDump() 导出
installMediaDebugProbe()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
)
