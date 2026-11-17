$ErrorActionPreference = 'Stop'
$request = ($input | Out-String) | ConvertFrom-Json

# WM_NCHITTEST also covers the non-client resize border, which CDP mouse
# injection bypasses. Query only the supplied test window; never move a cursor.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TujiHitTest {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
[void][TujiHitTest]::SetThreadDpiAwarenessContext([IntPtr](-4))
$targetWindow = [IntPtr]([long]$request.handle)
$clientRect = [TujiHitTest+Rect]::new()
$origin = [TujiHitTest+Point]::new()
if (-not [TujiHitTest]::GetClientRect($targetWindow, [ref]$clientRect)) { throw 'Test window is unavailable.' }
if (-not [TujiHitTest]::ClientToScreen($targetWindow, [ref]$origin)) { throw 'Test window origin is unavailable.' }
$scaleX = $clientRect.Right / [double]$request.width
$scaleY = $clientRect.Bottom / [double]$request.height
$results = foreach ($point in $request.points) {
  $screenX = $origin.X + [int][Math]::Floor([double]$point.x * $scaleX)
  $screenY = $origin.Y + [int][Math]::Floor([double]$point.y * $scaleY)
  $packedPoint = ($screenY -shl 16) -bor ($screenX -band 0xffff)
  [pscustomobject]@{ label = $point.label; x = $point.x; y = $point.y;
    hit = [TujiHitTest]::SendMessage($targetWindow, 0x84, [IntPtr]::Zero, [IntPtr]$packedPoint).ToInt64() }
}
ConvertTo-Json -InputObject @($results) -Compress
