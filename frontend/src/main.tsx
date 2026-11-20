import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from '@/components/ThemeProvider'
import { initClientLogger } from '@/lib/clientLogger'
import { installMediaDebugProbe } from '@/lib/media-debug'
import { bootstrapDesktopWindowAuth } from '@/lib/desktopWindow'
import App from './App'
import './index.css'

// 初始化浏览器控制台日志上报：拦截 console 与未捕获异常，批量发送到后端写入 log/frontend-console.log
initClientLogger({ minLevel: 'debug' })

// 媒体元素诊断探针（临时）：localStorage.zviewer-media-debug === '1' 时启用，
// 抓取所有 play/pause/src=/new Audio 的调用堆栈，复现双声后 __mediaDump() 导出
installMediaDebugProbe()

// 桌面端独立评论窗口：后端把登录票据放在 URL 里，必须在首帧渲染前写进本地存储，
// 这样 AuthInitializer 的 /api/auth/me 才能带上身份（普通页面没有 desktopWindow 参数）。
bootstrapDesktopWindowAuth()

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
