@echo off
chcp 65001 >nul 2>&1
echo ========================================
echo 图记 - 启动脚本
echo ========================================
echo.

echo 正在检查 Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未安装 Node.js，请先安装 Node.js
    echo 请访问 https://nodejs.org 下载安装
    pause
    exit /b 1
)

echo Node.js 已安装
node --version

echo.
echo 正在检查依赖...
if not exist "node_modules" (
    echo [提示] 首次运行，正在安装依赖（可能需要几分钟）...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
    echo.
    echo [成功] 依赖安装完成
) else (
    echo [提示] 依赖已安装
)

echo.
echo ========================================
echo 正在启动开发服务器...
echo ========================================
echo.
echo 浏览器将打开 http://localhost:5173
echo.
echo 按 Ctrl+C 可以停止服务器
echo.

call npm run dev

pause
