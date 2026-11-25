@echo off
setlocal
chcp 65001 >nul 2>&1
pushd "%~dp0.." || exit /b 1
echo ========================================
echo 图记 - 启动脚本
echo ========================================
echo.

echo 正在检查 Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未安装 Node.js，请先安装 Node.js
    echo 请访问 https://nodejs.org 下载安装
    goto failed
)

echo Node.js 已安装
node --version

echo.
echo 正在检查依赖...
if not exist "node_modules" (
    echo [提示] 首次运行，正在安装依赖（可能需要几分钟）...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [错误] 依赖安装失败
        goto failed
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
echo 服务启动后，请在浏览器中打开终端显示的地址。
echo.
echo 按 Ctrl+C 可以停止服务器
echo.

call npm run dev
set "result=%errorlevel%"
goto finished

:failed
set "result=1"
:finished
popd
pause
exit /b %result%
