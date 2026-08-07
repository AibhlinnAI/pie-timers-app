using System.Diagnostics;

namespace PieTimersScreensaver;

/// <summary>
/// Shown when someone clicks "Settings" in the Screen Saver Settings
/// dialog. There is nothing to configure -- the saver always shows
/// whichever timer is next -- so this is plain information, not a
/// settings form pretending to have options.
/// </summary>
public class ConfigForm : Form
{
    public ConfigForm()
    {
        Text = "Pie Timers screen saver";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(380, 190);

        var label = new Label
        {
            Text = "Shows your live Pie Timers countdown as a screen saver.\n\n" +
                   "Nothing to configure — it always shows whichever timer is\n" +
                   "next: lunch, end of day, or your next appointment.",
            AutoSize = false,
            Dock = DockStyle.Top,
            Height = 100,
            Padding = new Padding(16, 16, 16, 0)
        };

        var link = new LinkLabel
        {
            Text = "Open Pie Timers",
            Dock = DockStyle.Top,
            Height = 30,
            Padding = new Padding(16, 4, 0, 0)
        };
        link.LinkClicked += (_, _) =>
            Process.Start(new ProcessStartInfo(Program.HomeUrl) { UseShellExecute = true });

        var ok = new Button
        {
            Text = "OK",
            DialogResult = DialogResult.OK,
            Dock = DockStyle.Bottom,
            Height = 36
        };
        ok.Click += (_, _) => Close();

        Controls.Add(ok);
        Controls.Add(link);
        Controls.Add(label);
        AcceptButton = ok;
    }
}
