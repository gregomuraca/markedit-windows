param([int]$AppProcessId,[string]$DialogTitle,[string]$ExpectedName,[string]$Destination,[switch]$Cancel)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ExportDialog {
  public delegate bool EnumProc(IntPtr hwnd,IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb,IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd,EnumProc cb,IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd,StringBuilder text,int count);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr count,string text);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr count,StringBuilder text);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr a,IntPtr b);
  public static bool Complete(int pid,string title,string expected,string destination,bool cancel) {
    bool found=false;
    EnumWindows((hwnd,unused)=>{
      uint owner;GetWindowThreadProcessId(hwnd,out owner);if(owner!=pid)return true;
      var caption=new StringBuilder(512);GetWindowText(hwnd,caption,512);if(caption.ToString()!=title)return true;
      IntPtr filename=IntPtr.Zero,button=IntPtr.Zero;
      EnumChildWindows(hwnd,(child,data)=>{
        var cls=new StringBuilder(128);GetClassName(child,cls,128);
        var text=new StringBuilder(4096);SendMessage(child,0x000D,(IntPtr)4096,text);
        if(cls.ToString()=="Edit" && text.ToString()==expected)filename=child;
        if(cls.ToString()=="Button" && text.ToString().Replace("&","")==(cancel?"Cancel":"Save"))button=child;
        return true;
      },IntPtr.Zero);
      if(filename!=IntPtr.Zero && button!=IntPtr.Zero){
        if(!cancel)SendMessage(filename,0x000C,IntPtr.Zero,destination);
        SendMessage(button,0x00F5,IntPtr.Zero,IntPtr.Zero);found=true;return false;
      }
      return true;
    },IntPtr.Zero);
    return found;
  }
}
'@
$taskDeadline=[DateTime]::UtcNow.AddSeconds(25)
do {
  if([ExportDialog]::Complete($AppProcessId,$DialogTitle,$ExpectedName,$Destination,$Cancel.IsPresent)){Write-Output "PASS: $DialogTitle suggested $ExpectedName";exit 0}
  Start-Sleep -Milliseconds 100
} while([DateTime]::UtcNow -lt $taskDeadline)
throw "Expected filename '$ExpectedName' was not found in '$DialogTitle'."
