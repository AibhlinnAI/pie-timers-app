using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PieTimersScreensaver;

/// <summary>
/// One instance per monitor when actually running (see Program.cs), or a
/// single instance reparented into the small preview box in Windows'
/// Screen Saver Settings dialog when launched with /p.
///
/// Premium-gated: every instance loads the local entitlement gate
/// (gate.html) first, over a virtual host so it has a stable origin for
/// its own sign-in session, and only navigates to the real live pie once
/// the gate posts back 'entitled'. Applies to the preview thumbnail too,
/// deliberately -- gating only the full-screen case would let anyone see
/// the live pie for free just by opening Settings and clicking Preview.
/// </summary>
public class SaverForm : Form
{
    // IANA reserves .internal for exactly this -- a hostname guaranteed
    // never to collide with a real, routable domain. WebView2 intercepts
    // requests to it before any real DNS lookup happens.
    private const string GateVirtualHost = "pietimers-screensaver.internal";
    private const string GateUrl = "https://" + GateVirtualHost + "/gate.html";

    // How long the gate page gets to prove it is even running (loading
    // its scripts, calling identity.init()) before this gives up and
    // shows the fallback. Deliberately generous, and deliberately NOT
    // the same timeout gate.html uses for the entitlement check itself
    // -- that one already fails closed on its own, with its own message;
    // this one only exists to catch the page never running at all.
    private const int GateReadyTimeoutMs = 20000;

    private readonly WebView2 _webView = new();
    private readonly Label _fallback;
    private readonly nint? _previewParent;
    private System.Windows.Forms.Timer? _gateReadyTimeout;
    private bool _gateIsAlive;

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
        FormClosed += (_, _) =>
        {
            _gateReadyTimeout?.Dispose();
            if (!_previewParent.HasValue) Cursor.Show();
        };
    }

    private async void OnLoadAsync(object? sender, EventArgs e)
    {
        if (!_previewParent.HasValue) Cursor.Hide();

        try
        {
            await _webView.EnsureCoreWebView2Async();

            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                GateVirtualHost, AppContext.BaseDirectory, CoreWebView2HostResourceAccessKind.Allow);

            _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            _webView.CoreWebView2.NavigationCompleted += OnNavigationCompleted;

            // The only path that is allowed to ever show the fallback
            // BEFORE the gate has had a chance to answer for itself --
            // see the 'ready' handling below, which is what cancels this
            // the moment the gate page proves its own JS is running.
            _gateReadyTimeout = new System.Windows.Forms.Timer { Interval = GateReadyTimeoutMs };
            _gateReadyTimeout.Tick += (_, _) =>
            {
                _gateReadyTimeout?.Stop();
                if (!_gateIsAlive) ShowFallback();
            };
            _gateReadyTimeout.Start();

            _webView.Source = new Uri(GateUrl);
        }
        catch
        {
            // No WebView2 runtime, no network, or a blocked profile
            // directory -- whatever the cause, a black screen with a
            // plain sentence beats a crash or an unexplained blank
            // full-screen window.
            //
            // A broken WebView2 control left sitting in the form can
            // itself throw when the fallback Label is later made
            // visible -- SetVisibleCore forces the whole control tree
            // to realize real window handles, including this one.
            // Confirmed live, not theorized: this exact chain took the
            // whole process down during testing, with the second
            // exception (a plain "Error creating window handle") giving
            // no hint it started with a failed WebView2 init. Removing
            // the broken control first is what stops the fallback path
            // -- the one thing that must never itself fail -- from
            // being able to fail the same way.
            try
            {
                Controls.Remove(_webView);
                _webView.Dispose();
            }
            catch { /* best-effort -- ShowFallback below is what must not fail */ }
            ShowFallback();
        }

        if (_previewParent.HasValue) EmbedAsPreview(_previewParent.Value);
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string message;
        try { message = e.TryGetWebMessageAsString(); }
        catch { return; }

        switch (message)
        {
            case "ready":
                // The gate page's own JS is alive and now owns whatever
                // this window shows -- sign-in prompt, a spinner, or a
                // plain "Premium feature" message are all legitimate,
                // deliberate states of its own, never a failure this
                // process should paper over with the generic fallback.
                _gateIsAlive = true;
                _gateReadyTimeout?.Stop();
                break;

            case "entitled":
                // The only signal that is ever allowed to reveal the
                // real pie. Everything else -- false, an error, a
                // timeout inside the gate page itself -- leaves the
                // gate's own UI on screen instead, which is the
                // fail-closed default this exists to guarantee.
                _webView.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
                _webView.Source = new Uri(Program.SaverUrl);
                break;
        }
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
