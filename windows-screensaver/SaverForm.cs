using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PieTimersScreensaver;

/// <summary>
/// One instance per monitor when actually running (see Program.cs), or a
/// single instance reparented into the small preview box in Windows'
/// Screen Saver Settings dialog when launched with /p.
/// </summary>
public class SaverForm : Form
{
    private readonly WebView2 _webView = new();
    private readonly Label _fallback;
    private readonly nint? _previewParent;

    public SaverForm(Rectangle? bounds = null, nint? previewParent = null)
    {
        _previewParent = previewParent;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        BackColor = Color.Black;

        if (bounds.HasValue)
        {
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds.Value;
            TopMost = true;
        }

        _fallback = new Label
        {
            Dock = DockStyle.Fill,
            ForeColor = Color.White,
            BackColor = Color.Black,
            Font = new Font("Segoe UI", 14f),
            TextAlign = ContentAlignment.MiddleCenter,
            Text = "Pie Timers\n\nWaiting for a connection…",
            Visible = false
        };

        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);
        Controls.Add(_fallback);

        Load += OnLoadAsync;
        FormClosed += (_, _) => { if (!_previewParent.HasValue) Cursor.Show(); };
    }

    private async void OnLoadAsync(object? sender, EventArgs e)
    {
        if (!_previewParent.HasValue) Cursor.Hide();

        try
        {
            await _webView.EnsureCoreWebView2Async();
            _webView.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
            _webView.Source = new Uri(Program.SaverUrl);
        }
        catch
        {
            // No WebView2 runtime, no network, or a blocked profile
            // directory -- whatever the cause, a black screen with a
            // plain sentence beats a crash or an unexplained blank
            // full-screen window.
            ShowFallback();
        }

        if (_previewParent.HasValue) EmbedAsPreview(_previewParent.Value);
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess) ShowFallback();
    }

    private void ShowFallback()
    {
        _webView.Visible = false;
        _fallback.Visible = true;
    }

    // ── Win32 interop: overlaying the Settings-dialog preview box ──
    //
    // The obvious approach -- SetParent this window into the preview
    // box's HWND as a true child -- does not work reliably: Windows does
    // not support reparenting a window into a window owned by a
    // DIFFERENT process, which the Settings dialog's preview box always
    // is. Confirmed by direct testing here, not assumed from documentation
    // alone: reparenting appeared to succeed, but the resulting window
    // immediately misbehaved (IsWindow on the untouched parent handle
    // started reporting false within one polling tick, with nothing else
    // having touched it).
    //
    // The technique that actually works: leave this window a normal
    // top-level window, and position it in SCREEN coordinates to sit
    // exactly over the preview box's rectangle, without taking focus
    // from the Settings dialog. It looks embedded without needing to be
    // a real child window.

    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int GWL_EXSTYLE = -20;
    private const uint SWP_NOACTIVATE = 0x0010;
    private static readonly nint HWND_TOPMOST = new(-1);

    private void EmbedAsPreview(nint parentHandle)
    {
        try
        {
            var exStyle = GetWindowLong(Handle, GWL_EXSTYLE);
            SetWindowLong(Handle, GWL_EXSTYLE, exStyle | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);

            void SyncToParentRect()
            {
                GetWindowRect(parentHandle, out var rect);
                SetWindowPos(Handle, HWND_TOPMOST, rect.Left, rect.Top,
                    rect.Right - rect.Left, rect.Bottom - rect.Top, SWP_NOACTIVATE);
            }

            SyncToParentRect();
            Show();

            // Re-syncs position every tick (cheap, and covers the
            // Settings dialog being dragged) and doubles as the
            // dismiss watchdog: the preview box has no clean close
            // event this process can subscribe to, so noticing the
            // parent handle stop being a valid window is what signals
            // the dialog closed.
            var watchdog = new System.Windows.Forms.Timer { Interval = 250 };
            watchdog.Tick += (_, _) =>
            {
                if (!IsWindow(parentHandle)) { Application.Exit(); return; }
                SyncToParentRect();
            };
            watchdog.Start();
        }
        catch
        {
            // A failed preview overlay must never take down the Settings
            // dialog with it -- Windows just shows an empty box instead,
            // a cosmetic gap rather than a broken screen saver.
            Application.Exit();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] private static extern int GetWindowLong(nint hWnd, int nIndex);
    [DllImport("user32.dll")] private static extern int SetWindowLong(nint hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(nint hWnd, nint hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] private static extern bool IsWindow(nint hWnd);
}
