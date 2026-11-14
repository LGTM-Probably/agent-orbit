using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentOrbit
{
    internal static class FocusHelper
    {
        #region Win32 API

        private const uint TH32CS_SNAPPROCESS = 0x00000002;
        private const uint ASFW_ANY = 0xFFFFFFFF;
        private const int SW_RESTORE = 9;
        private const int SW_SHOW = 5;
        private const int ATTACH_PARENT_PROCESS = -1;
        private const int STD_OUTPUT_HANDLE = -11;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32
        {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

        [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

        [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        private static extern bool AllowSetForegroundWindow(uint dwProcessId);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr SetFocus(IntPtr hWnd);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int nStdHandle);

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetWindowRgn(IntPtr hWnd, IntPtr hRgn);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRectRgn(int nLeftRect, int nTopRect, int nRightRect, int nBottomRect);

        [DllImport("gdi32.dll")]
        private static extern int GetRgnBox(IntPtr hrgn, out RECT lprc);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        #endregion

        private class ProcessInfo
        {
            public uint Pid;
            public uint ParentPid;
            public string ExeNameLower;
        }

        private class WindowInfo
        {
            public IntPtr Hwnd;
            public uint Pid;
            public string ExeNameLower;
            public string ClassName;
            public string Title;
        }

        [STAThread]
        public static int Main(string[] args)
        {
            SetupConsoleOutput();

            string harness = "";
            uint pid = 0;
            string cwd = "";
            string project = "";
            string label = "";
            string entrypoint = "";
            bool dryRun = false;

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (string.Equals(arg, "--harness", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    harness = (args[++i] ?? "").Trim().ToLowerInvariant();
                }
                else if (string.Equals(arg, "--pid", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    uint.TryParse(args[++i], out pid);
                }
                else if (string.Equals(arg, "--cwd", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    cwd = (args[++i] ?? "").Trim();
                }
                else if (string.Equals(arg, "--project", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    project = (args[++i] ?? "").Trim();
                }
                else if (string.Equals(arg, "--label", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    label = (args[++i] ?? "").Trim();
                }
                else if (string.Equals(arg, "--entrypoint", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    entrypoint = (args[++i] ?? "").Trim().ToLowerInvariant();
                }
                else if (string.Equals(arg, "--dry-run", StringComparison.OrdinalIgnoreCase))
                {
                    dryRun = true;
                }
                else if (string.Equals(arg, "--check-rgn", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    long hwndVal = 0;
                    long.TryParse(args[++i], out hwndVal);
                    IntPtr hWnd = new IntPtr(hwndVal);
                    IntPtr hRgn = CreateRectRgn(0, 0, 0, 0);
                    int res = GetWindowRgn(hWnd, hRgn);
                    if (res == 0)
                    {
                        Console.WriteLine("NO_REGION");
                    }
                    else
                    {
                        RECT rc;
                        GetRgnBox(hRgn, out rc);
                        string rgnType = res == 1 ? "NULLREGION" : res == 2 ? "SIMPLEREGION" : "COMPLEXREGION";
                        Console.WriteLine(string.Format("REGION({0}, box=[{1}, {2}, {3}, {4}])", rgnType, rc.Left, rc.Top, rc.Right, rc.Bottom));
                    }
                    DeleteObject(hRgn);
                    return 0;
                }
            }

            Dictionary<uint, ProcessInfo> procMap = SnapshotProcesses();
            List<WindowInfo> windows = EnumerateWindows(procMap);

            WindowInfo candidate = null;

            // Step 1: Live PID tree walk
            if (pid > 0 && procMap.ContainsKey(pid))
            {
                HashSet<string> knownGuiExes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                {
                    "claude.exe",
                    "tabby.exe",
                    "windowsterminal.exe",
                    "code.exe",
                    "cursor.exe",
                    "antigravity.exe",
                    "strata-desktop.exe"
                };

                HashSet<uint> visited = new HashSet<uint>();
                uint cur = pid;
                for (int hop = 0; hop < 12; hop++)
                {
                    if (cur == 0 || visited.Contains(cur))
                        break;
                    visited.Add(cur);

                    // 1. Exact PID match first
                    for (int i = 0; i < windows.Count; i++)
                    {
                        if (windows[i].Pid == cur)
                        {
                            candidate = windows[i];
                            break;
                        }
                    }
                    if (candidate != null) break;

                    // 2. If this process is one of the known GUI apps, match by app executable
                    ProcessInfo curProc;
                    if (procMap.TryGetValue(cur, out curProc) && !string.IsNullOrEmpty(curProc.ExeNameLower))
                    {
                        if (knownGuiExes.Contains(curProc.ExeNameLower))
                        {
                            WindowInfo firstMatch = null;
                            for (int i = 0; i < windows.Count; i++)
                            {
                                if (string.Equals(windows[i].ExeNameLower, curProc.ExeNameLower, StringComparison.OrdinalIgnoreCase))
                                {
                                    if (firstMatch == null) firstMatch = windows[i];
                                    if (TitleMatchesCwd(windows[i].Title, cwd) || TitleMatchesProject(windows[i].Title, project))
                                    {
                                        candidate = windows[i];
                                        break;
                                    }
                                }
                            }
                            if (candidate == null && firstMatch != null)
                            {
                                candidate = firstMatch;
                            }
                            if (candidate != null) break;
                        }
                    }

                    if (procMap.TryGetValue(cur, out curProc) && curProc.ParentPid > 0 && curProc.ParentPid != cur)
                    {
                        cur = curProc.ParentPid;
                    }
                    else
                    {
                        break;
                    }
                }
            }

            // Step 2: Codex live process tree walk
            if (candidate == null && string.Equals(harness, "codex", StringComparison.OrdinalIgnoreCase))
            {
                List<uint> codexPids = new List<uint>();
                foreach (KeyValuePair<uint, ProcessInfo> kvp in procMap)
                {
                    if (string.Equals(kvp.Value.ExeNameLower, "codex.exe", StringComparison.OrdinalIgnoreCase))
                    {
                        codexPids.Add(kvp.Key);
                    }
                }

                HashSet<string> codexTargetExes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                {
                    "tabby.exe",
                    "windowsterminal.exe",
                    "code.exe",
                    "codex.exe",
                    "cursor.exe"
                };

                int bestCodexScore = -1;
                WindowInfo bestCodexWin = null;

                foreach (uint cPid in codexPids)
                {
                    HashSet<uint> visited = new HashSet<uint>();
                    uint cur = cPid;
                    for (int hop = 0; hop < 12; hop++)
                    {
                        if (cur == 0 || visited.Contains(cur))
                            break;
                        visited.Add(cur);

                        for (int i = 0; i < windows.Count; i++)
                        {
                            WindowInfo win = windows[i];
                            bool pidMatches = win.Pid == cur;
                            bool appMatches = codexTargetExes.Contains(win.ExeNameLower) &&
                                              procMap.ContainsKey(cur) &&
                                              string.Equals(procMap[cur].ExeNameLower, win.ExeNameLower, StringComparison.OrdinalIgnoreCase);

                            if (pidMatches || appMatches)
                            {
                                int score = 50;
                                if (TitleMatchesCwd(win.Title, cwd)) score += 80;
                                if (TitleMatchesProject(win.Title, project)) score += 40;
                                if (string.Equals(win.ExeNameLower, "codex.exe", StringComparison.OrdinalIgnoreCase)) score += 30;

                                if (score > bestCodexScore)
                                {
                                    bestCodexScore = score;
                                    bestCodexWin = win;
                                }
                            }
                        }

                        ProcessInfo p;
                        if (procMap.TryGetValue(cur, out p) && p.ParentPid > 0 && p.ParentPid != cur)
                        {
                            cur = p.ParentPid;
                        }
                        else
                        {
                            break;
                        }
                    }
                }

                if (bestCodexWin != null)
                {
                    candidate = bestCodexWin;
                }
            }

            // Step 3: Harness-specific window matching fallback
            if (candidate == null)
            {
                int bestScore = -1;
                WindowInfo bestWin = null;

                for (int i = 0; i < windows.Count; i++)
                {
                    WindowInfo win = windows[i];
                    string exe = win.ExeNameLower;
                    int score = 0;

                    if (string.Equals(harness, "antigravity", StringComparison.OrdinalIgnoreCase))
                    {
                        if (string.Equals(exe, "antigravity.exe", StringComparison.OrdinalIgnoreCase))
                        {
                            score = 10;
                            if (TitleMatchesLabel(win.Title, label)) score += 100;
                            if (TitleMatchesProject(win.Title, project)) score += 50;
                        }
                    }
                    else if (string.Equals(harness, "strata", StringComparison.OrdinalIgnoreCase))
                    {
                        if (string.Equals(exe, "strata-desktop.exe", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(exe, "strata.exe", StringComparison.OrdinalIgnoreCase) ||
                            (string.Equals(win.ClassName, "Tauri Window", StringComparison.OrdinalIgnoreCase) &&
                             win.Title.IndexOf("Strata", StringComparison.OrdinalIgnoreCase) >= 0))
                        {
                            score = 10;
                            if (TitleMatchesProject(win.Title, project)) score += 50;
                            if (TitleMatchesLabel(win.Title, label)) score += 40;
                        }
                    }
                    else if (string.Equals(harness, "claude", StringComparison.OrdinalIgnoreCase))
                    {
                        bool isTerminal = string.Equals(exe, "tabby.exe", StringComparison.OrdinalIgnoreCase) ||
                                          string.Equals(exe, "windowsterminal.exe", StringComparison.OrdinalIgnoreCase) ||
                                          string.Equals(exe, "code.exe", StringComparison.OrdinalIgnoreCase) ||
                                          string.Equals(exe, "cursor.exe", StringComparison.OrdinalIgnoreCase);

                        if (string.Equals(entrypoint, "claude-desktop", StringComparison.OrdinalIgnoreCase))
                        {
                            if (string.Equals(exe, "claude.exe", StringComparison.OrdinalIgnoreCase))
                            {
                                score = 100;
                            }
                            else if (isTerminal)
                            {
                                score = 20;
                                if (TitleMatchesCwd(win.Title, cwd)) score += 80;
                                if (TitleMatchesProject(win.Title, project)) score += 40;
                            }
                        }
                        else if (string.Equals(entrypoint, "cli", StringComparison.OrdinalIgnoreCase) ||
                                 string.Equals(entrypoint, "sdk-cli", StringComparison.OrdinalIgnoreCase))
                        {
                            if (isTerminal)
                            {
                                score = 20;
                                if (TitleMatchesCwd(win.Title, cwd)) score += 80;
                                if (TitleMatchesProject(win.Title, project)) score += 40;
                            }
                            else if (string.Equals(exe, "claude.exe", StringComparison.OrdinalIgnoreCase))
                            {
                                score = 10;
                            }
                        }
                        else
                        {
                            if (string.Equals(exe, "claude.exe", StringComparison.OrdinalIgnoreCase))
                            {
                                score = 60;
                            }
                            else if (string.Equals(exe, "tabby.exe", StringComparison.OrdinalIgnoreCase))
                            {
                                score = TitleMatchesCwd(win.Title, cwd) ? 80 : 50;
                                if (TitleMatchesProject(win.Title, project)) score += 20;
                            }
                            else if (isTerminal)
                            {
                                score = 20;
                                if (TitleMatchesCwd(win.Title, cwd)) score += 80;
                                if (TitleMatchesProject(win.Title, project)) score += 40;
                            }
                        }
                    }
                    else if (string.Equals(harness, "codex", StringComparison.OrdinalIgnoreCase))
                    {
                        bool isTerminal = string.Equals(exe, "tabby.exe", StringComparison.OrdinalIgnoreCase) ||
                                          string.Equals(exe, "windowsterminal.exe", StringComparison.OrdinalIgnoreCase) ||
                                          string.Equals(exe, "code.exe", StringComparison.OrdinalIgnoreCase) ||
                                          string.Equals(exe, "cursor.exe", StringComparison.OrdinalIgnoreCase);

                        if (string.Equals(exe, "codex.exe", StringComparison.OrdinalIgnoreCase))
                        {
                            score = 90;
                        }
                        else if (isTerminal)
                        {
                            score = 20;
                            if (TitleMatchesCwd(win.Title, cwd)) score += 80;
                            if (TitleMatchesProject(win.Title, project)) score += 40;
                        }
                    }

                    if (score > bestScore && score > 0)
                    {
                        bestScore = score;
                        bestWin = win;
                    }
                }

                if (bestWin != null)
                {
                    candidate = bestWin;
                }
            }

            // Step 4: Outcome
            if (candidate == null)
            {
                PrintJson("{\"ok\":false,\"reason\":\"No matching open window found\"}");
                return 0;
            }

            if (!dryRun)
            {
                AllowSetForegroundWindow(ASFW_ANY);

                if (IsIconic(candidate.Hwnd))
                {
                    ShowWindowAsync(candidate.Hwnd, SW_RESTORE);
                }
                else
                {
                    ShowWindowAsync(candidate.Hwnd, SW_SHOW);
                }

                uint fgPid;
                IntPtr fgHwnd = GetForegroundWindow();
                uint fgThread = GetWindowThreadProcessId(fgHwnd, out fgPid);
                uint targetPid;
                uint targetThread = GetWindowThreadProcessId(candidate.Hwnd, out targetPid);
                uint curThread = GetCurrentThreadId();

                bool attachedFg = false;
                if (fgThread != 0 && fgThread != targetThread)
                {
                    attachedFg = AttachThreadInput(fgThread, targetThread, true);
                }

                bool attachedCur = false;
                if (curThread != 0 && curThread != targetThread)
                {
                    attachedCur = AttachThreadInput(curThread, targetThread, true);
                }

                BringWindowToTop(candidate.Hwnd);
                SetForegroundWindow(candidate.Hwnd);
                SetFocus(candidate.Hwnd);

                if (attachedCur)
                {
                    AttachThreadInput(curThread, targetThread, false);
                }
                if (attachedFg)
                {
                    AttachThreadInput(fgThread, targetThread, false);
                }
            }

            string appName = !string.IsNullOrEmpty(candidate.ExeNameLower)
                ? candidate.ExeNameLower
                : (!string.IsNullOrEmpty(harness) ? harness : "unknown");

            string json = string.Format(
                "{{\"ok\":true,\"targetApp\":\"{0}\",\"windowTitle\":\"{1}\"}}",
                EscapeJson(appName),
                EscapeJson(candidate.Title)
            );

            PrintJson(json);
            return 0;
        }

        private static void SetupConsoleOutput()
        {
            try
            {
                IntPtr stdOut = GetStdHandle(STD_OUTPUT_HANDLE);
                if (stdOut == IntPtr.Zero || stdOut == new IntPtr(-1))
                {
                    AttachConsole(ATTACH_PARENT_PROCESS);
                }
                Stream outStream = Console.OpenStandardOutput();
                if (outStream != null && outStream != Stream.Null)
                {
                    StreamWriter sw = new StreamWriter(outStream, new UTF8Encoding(false));
                    sw.AutoFlush = true;
                    Console.SetOut(sw);
                }
            }
            catch
            {
            }
        }

        private static void PrintJson(string json)
        {
            try
            {
                Console.WriteLine(json);
                Console.Out.Flush();
            }
            catch
            {
            }
        }

        private static Dictionary<uint, ProcessInfo> SnapshotProcesses()
        {
            Dictionary<uint, ProcessInfo> map = new Dictionary<uint, ProcessInfo>();
            IntPtr hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (hSnap == IntPtr.Zero || hSnap == new IntPtr(-1))
                return map;

            try
            {
                PROCESSENTRY32 pe = new PROCESSENTRY32();
                pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (Process32First(hSnap, ref pe))
                {
                    do
                    {
                        map[pe.th32ProcessID] = new ProcessInfo
                        {
                            Pid = pe.th32ProcessID,
                            ParentPid = pe.th32ParentProcessID,
                            ExeNameLower = (pe.szExeFile ?? "").ToLowerInvariant()
                        };
                    } while (Process32Next(hSnap, ref pe));
                }
            }
            catch
            {
            }
            finally
            {
                CloseHandle(hSnap);
            }

            return map;
        }

        private static List<WindowInfo> EnumerateWindows(Dictionary<uint, ProcessInfo> procMap)
        {
            List<WindowInfo> list = new List<WindowInfo>();

            try
            {
                EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
                {
                    try
                    {
                        if (!IsWindowVisible(hWnd))
                            return true;

                        int len = GetWindowTextLength(hWnd);
                        if (len <= 0)
                            return true;

                        StringBuilder titleSb = new StringBuilder(len + 2);
                        GetWindowText(hWnd, titleSb, titleSb.Capacity);
                        string title = titleSb.ToString().Trim();
                        if (string.IsNullOrEmpty(title))
                            return true;

                        if (string.Equals(title, "Agent Orbit", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(title, "Program Manager", StringComparison.OrdinalIgnoreCase))
                        {
                            return true;
                        }

                        uint pid;
                        GetWindowThreadProcessId(hWnd, out pid);

                        StringBuilder classSb = new StringBuilder(256);
                        GetClassName(hWnd, classSb, classSb.Capacity);
                        string className = classSb.ToString();

                        string exeName = "";
                        ProcessInfo pInfo;
                        if (procMap.TryGetValue(pid, out pInfo) && !string.IsNullOrEmpty(pInfo.ExeNameLower))
                        {
                            exeName = pInfo.ExeNameLower;
                        }

                        list.Add(new WindowInfo
                        {
                            Hwnd = hWnd,
                            Pid = pid,
                            ExeNameLower = exeName,
                            ClassName = className,
                            Title = title
                        });
                    }
                    catch
                    {
                    }
                    return true;
                }, IntPtr.Zero);
            }
            catch
            {
            }

            return list;
        }

        private static bool TitleMatchesCwd(string title, string cwd)
        {
            if (string.IsNullOrEmpty(cwd) || string.IsNullOrEmpty(title)) return false;
            string normCwd = cwd.Replace('\\', '/').TrimEnd('/');
            if (normCwd.Length <= 3) return false;

            if (title.IndexOf(normCwd, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (title.IndexOf(cwd, StringComparison.OrdinalIgnoreCase) >= 0) return true;

            // Form: /c/Users/... from C:/Users/...
            if (normCwd.Length >= 2 && normCwd[1] == ':')
            {
                string posixForm = "/" + char.ToLowerInvariant(normCwd[0]) + normCwd.Substring(2);
                if (title.IndexOf(posixForm, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }

            return false;
        }

        private static bool TitleMatchesProject(string title, string project)
        {
            if (string.IsNullOrEmpty(project) || string.IsNullOrEmpty(title)) return false;
            if (string.Equals(project, "workspace", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(project, "home", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            return title.IndexOf(project, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static bool TitleMatchesLabel(string title, string label)
        {
            if (string.IsNullOrEmpty(label) || string.IsNullOrEmpty(title)) return false;
            return title.IndexOf(label, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string EscapeJson(string s)
        {
            if (s == null) return "";
            StringBuilder sb = new StringBuilder(s.Length + 8);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '\"': sb.Append("\\\""); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32)
                        {
                            sb.AppendFormat("\\u{0:x4}", (int)c);
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
