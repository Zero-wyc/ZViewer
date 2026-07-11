#!/usr/bin/env pwsh
#Requires -Version 5.1

param(
    [int]$Port = 3000,
    [int]$FrontendPort = 4173
)

$ErrorActionPreference = "SilentlyContinue"

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
$pidsFile = Join-Path $rootDir ".prod.pids.json"

function Stop-ProcessById {
    param([int]$ProcessId)
    try {
        $proc = Get-Process -Id $ProcessId
        Stop-Process -Id $ProcessId -Force
        Write-Host "已结束进程 PID $ProcessId ($($proc.ProcessName))"
        return $true
    } catch {
        Write-Host "进程 PID $ProcessId 不存在或已结束"
        return $false
    }
}

function Stop-ProcessByPort {
    param([int]$LocalPort)
    try {
        $conns = Get-NetTCPConnection -LocalPort $LocalPort -ErrorAction SilentlyContinue
        $owningPids = $conns | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique
        if (-not $owningPids) {
            Write-Host "端口 $LocalPort 未被占用"
            return
        }
        foreach ($pid in $owningPids) {
            try {
                $proc = Get-Process -Id $pid
                Stop-Process -Id $pid -Force
                Write-Host "已结束占用端口 $LocalPort 的进程 PID $pid ($($proc.ProcessName))"
            } catch {
                Write-Host "无法结束占用端口 $LocalPort 的进程 PID $pid"
            }
        }
    } catch {
        Write-Host "查找端口 $LocalPort 失败：$_"
    }
}

if (Test-Path $pidsFile) {
    Write-Host "读取 PID 文件：$pidsFile"
    try {
        $pids = Get-Content $pidsFile -Raw | ConvertFrom-Json
        if ($pids.backend -and $pids.backend.pid) {
            Stop-ProcessById -ProcessId $pids.backend.pid
        }
        if ($pids.frontend -and $pids.frontend.pid) {
            Stop-ProcessById -ProcessId $pids.frontend.pid
        }
    } catch {
        Write-Host "解析 PID 文件失败，回退到按端口查找：$_"
        Stop-ProcessByPort -LocalPort $Port
        Stop-ProcessByPort -LocalPort $FrontendPort
    }
    Remove-Item $pidsFile -Force
    Write-Host "已清理 PID 文件"
} else {
    Write-Host "未找到 PID 文件，尝试按端口查找 ..."
    Stop-ProcessByPort -LocalPort $Port
    Stop-ProcessByPort -LocalPort $FrontendPort
}

Write-Host "生产服务已停止"
