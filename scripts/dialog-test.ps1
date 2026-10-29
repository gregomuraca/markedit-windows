param([int]$AppProcessId, [string]$DialogTitle, [string]$ButtonText)
# Test helper: interact only with a named dialog belonging to the test-launched app.
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TestDialog {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int length);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    public static bool Click(int pid, string title, string button) {
        bool found = false;
        EnumWindows((hwnd, _) => {
            uint owner; GetWindowThreadProcessId(hwnd, out owner);
            var text = new StringBuilder(512); GetWindowText(hwnd, text, text.Capacity);
            if (owner != pid || text.ToString() != title) return true;
            EnumChildWindows(hwnd, (child, unused) => {
                var label = new StringBuilder(512); GetWindowText(child, label, label.Capacity);
                var cls = new StringBuilder(64); GetClassName(child, cls, cls.Capacity);
                if (cls.ToString() == "Button" && label.ToString().Replace("&", "") == button) {
                    SendMessage(child, 0x00F5, IntPtr.Zero, IntPtr.Zero); found = true; return false;
                }
                return true;
            }, IntPtr.Zero);
            return !found;
        }, IntPtr.Zero);
        return found;
    }
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(20)
do {
    if ([TestDialog]::Click($AppProcessId, $DialogTitle, $ButtonText)) { Write-Output "Clicked $ButtonText in $DialogTitle"; exit 0 }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
throw "Did not find '$ButtonText' in app dialog '$DialogTitle'."
