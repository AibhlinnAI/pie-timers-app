using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PieTimersScreensaver;

/// <summary>
/// A real screen saver must exit on ANY input, anywhere on screen -- not
/// just input that happens to land on this app's own window. WebView2
/// hosts a full Chromium instance that handles mouse/keyboard itself and
/// does not reliably bubble ordinary WinForms MouseMove/KeyDown events up
/// to the host Form, so watching those events would miss most real input.
/// A system-wide low-level hook is the only mechanism that sees
/// everything regardless of which window has focus, which is what every
/// real Windows screen saver relies on.
/// </summary>
internal static class InputWatcher
{
    private const int WH_MOUSE_LL = 14;
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_MOUSEMOVE = 0x0200;

    // Movement smaller than this is treated as noise -- some hardware/
    // drivers fire a spurious first MouseMove at the cursor's existing
    // position when a full-screen window appears, which must not
    // immediately dismiss the saver it was just asked to show.
    private const int MoveThresholdPixels = 4;

    private delegate nint LowLevelProc(int nCode, nint wParam, nint lParam);

    // Kept as a field, not a local -- a delegate passed to native code
    // must not be garbage-collected while the hook is installed, or the
    // callback pointer goes stale and the process can crash on the next
    // input event.
    private static readonly LowLevelProc MouseProcDelegate = MouseHookCallback;
    private static readonly LowLevelProc KeyboardProcDelegate = KeyboardHookCallback;

    private static nint _mouseHookId;
    private static nint _keyboardHookId;
    private static Point _initialPos;
    private static bool _active;

    public static event Action? InputDetected;

    public static void Start()
    {
        _initialPos = Cursor.Position;
        _active = true;
        using var process = Process.GetCurrentProcess();
        using var module = process.MainModule!;
        var moduleHandle = GetModuleHandle(module.ModuleName);
        _mouseHookId = SetWindowsHookEx(WH_MOUSE_LL, MouseProcDelegate, moduleHandle, 0);
        _keyboardHookId = SetWindowsHookEx(WH_KEYBOARD_LL, KeyboardProcDelegate, moduleHandle, 0);
    }

    public static void Stop()
    {
        _active = false;
        if (_mouseHookId != 0) { UnhookWindowsHookEx(_mouseHookId); _mouseHookId = 0; }
        if (_keyboardHookId != 0) { UnhookWindowsHookEx(_keyboardHookId); _keyboardHookId = 0; }
    }

    private static nint MouseHookCallback(int nCode, nint wParam, nint lParam)
    {
        if (nCode >= 0 && _active)
        {
            if (wParam == WM_MOUSEMOVE)
            {
                var data = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
                var dx = Math.Abs(data.pt.x - _initialPos.X);
                var dy = Math.Abs(data.pt.y - _initialPos.Y);
                if (dx > MoveThresholdPixels || dy > MoveThresholdPixels) InputDetected?.Invoke();
            }
            else
            {
                // Any button down/up or wheel event is a deliberate action,
                // not incidental movement -- no threshold for those.
                InputDetected?.Invoke();
            }
        }
        return CallNextHookEx(_mouseHookId, nCode, wParam, lParam);
    }

    private static nint KeyboardHookCallback(int nCode, nint wParam, nint lParam)
    {
        if (nCode >= 0 && _active) InputDetected?.Invoke();
        return CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public nint dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SetWindowsHookEx(int idHook, LowLevelProc lpfn, nint hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(nint hhk);

    [DllImport("user32.dll")]
    private static extern nint CallNextHookEx(nint hhk, int nCode, nint wParam, nint lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern nint GetModuleHandle(string? lpModuleName);
}
