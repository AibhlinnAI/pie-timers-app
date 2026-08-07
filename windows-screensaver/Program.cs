namespace PieTimersScreensaver;

/// <summary>
/// Windows launches a .scr with one of three conventions, and different
/// launchers are inconsistent about the exact spelling:
///   /s            run for real, full screen
///   /c or /c:HWND show the configuration dialog
///   /p HWND       render into the small preview box in Settings
/// No argument at all is treated the same as /s -- a screen saver that
/// silently does nothing when double-clicked is more confusing than one
/// that just runs.
/// </summary>
internal static class Program
{
    public const string SaverUrl = "https://pietimers.aibhlinn.ai/index.html?focus=1";
    public const string HomeUrl = "https://pietimers.aibhlinn.ai/";

    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        var mode = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : string.Empty;

        if (mode.StartsWith("/c") || mode.StartsWith("-c"))
        {
            Application.Run(new ConfigForm());
        }
        else if (mode.StartsWith("/p") || mode.StartsWith("-p"))
        {
            RunPreview(mode, args);
        }
        else
        {
            RunFullScreen();
        }
    }

    private static void RunPreview(string mode, string[] args)
    {
        // The preview handle arrives either as a second argument ("/p 1234")
        // or joined onto the first with a colon ("/p:1234") depending on
        // what launched it -- both are seen in practice.
        var handleText = args.Length > 1 ? args[1] : mode.Contains(':') ? mode.Split(':')[1] : string.Empty;

        if (long.TryParse(handleText, out var handleValue) && handleValue != 0)
        {
            Application.Run(new SaverForm(previewParent: new nint(handleValue)));
            return;
        }

        // An unparseable or zero handle leaves nothing sensible to render
        // into. Environment.Exit rather than a plain return: relying on
        // Main() simply returning left the process observably alive for
        // several seconds during testing (a large self-contained
        // single-file publish has real startup/shutdown overhead), and a
        // screen saver invoked with a bad preview handle needs to be gone
        // immediately, not eventually.
        Environment.Exit(0);
    }

    private static void RunFullScreen()
    {
        InputWatcher.Start();

        var forms = new List<SaverForm>();

        void Dismiss()
        {
            InputWatcher.Stop();
            foreach (var form in forms)
            {
                if (!form.IsDisposed) form.Close();
            }
            Application.Exit();
        }

        InputWatcher.InputDetected += Dismiss;

        foreach (var screen in Screen.AllScreens)
        {
            var form = new SaverForm(bounds: screen.Bounds);
            forms.Add(form);
            form.Show();
        }

        Application.Run();
    }
}
