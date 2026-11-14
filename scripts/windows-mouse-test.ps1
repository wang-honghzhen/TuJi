$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TujiMouseTest {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public MouseInput mouse; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, System.Text.StringBuilder title, int capacity);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int metric);
  public static void Move(int x, int y) {
    var input = new Input { type = 0, mouse = new MouseInput {
      dx = (int)Math.Ceiling((x - GetSystemMetrics(76)) * 65536.0 / GetSystemMetrics(78)),
      dy = (int)Math.Ceiling((y - GetSystemMetrics(77)) * 65536.0 / GetSystemMetrics(79)), flags = 0xC001u } };
    if (SendInput(1, new [] { input }, Marshal.SizeOf(typeof(Input))) != 1) throw new Exception("Windows rejected cursor movement");
  }
  public static void Button(bool down) {
    var input = new Input { type = 0, mouse = new MouseInput { flags = down ? 2u : 4u } };
    if (SendInput(1, new [] { input }, Marshal.SizeOf(typeof(Input))) != 1) throw new Exception("Windows rejected mouse input");
  }
}
'@
[void][TujiMouseTest]::SetProcessDPIAware()
$originalPoint = New-Object TujiMouseTest+Point
[void][TujiMouseTest]::GetCursorPos([ref]$originalPoint)
$originalForeground = [TujiMouseTest]::GetForegroundWindow()
$pressed = $false
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      $request = $line | ConvertFrom-Json
      if ($request.action -eq 'stop') { break }
      foreach ($step in $request.steps) {
        if ($null -ne $step.x) { [TujiMouseTest]::Move([int]$step.x, [int]$step.y) }
        if ($step.button -eq 'down') { [TujiMouseTest]::Button($true); $pressed = $true }
        if ($step.button -eq 'up') { [TujiMouseTest]::Button($false); $pressed = $false }
        if ($step.wait) { Start-Sleep -Milliseconds $step.wait }
      }
      $point = New-Object TujiMouseTest+Point
      [void][TujiMouseTest]::GetCursorPos([ref]$point)
      $title = New-Object System.Text.StringBuilder 200
      [void][TujiMouseTest]::GetWindowText([TujiMouseTest]::WindowFromPoint($point), $title, 200)
      [Console]::WriteLine((@{ ok = $true; x = $point.X; y = $point.Y; title = $title.ToString() } | ConvertTo-Json -Compress))
    } catch { [Console]::WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)) }
  }
} finally {
  if ($pressed) { [TujiMouseTest]::Button($false) }
  [void][TujiMouseTest]::SetCursorPos($originalPoint.X, $originalPoint.Y)
  [void][TujiMouseTest]::SetForegroundWindow($originalForeground)
}
