using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

[assembly: AssemblyTitle("Agent Orbit")]
[assembly: AssemblyProduct("Agent Orbit")]
[assembly: AssemblyDescription("Agent Orbit Desktop Visualizer")]
[assembly: AssemblyCompany("Agent Orbit Contributors")]
[assembly: AssemblyCopyright("Copyright © 2026 Agent Orbit Contributors")]
[assembly: AssemblyVersion("0.2.0.0")]
[assembly: AssemblyFileVersion("0.2.0.0")]
[assembly: ComVisible(false)]

namespace AgentOrbit.Launcher
{
    internal static class Program
    {
        [DllImport("user32.dll", EntryPoint = "MessageBoxW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int MessageBox(IntPtr hWnd, string lpText, string lpCaption, uint uType);

        private const uint MB_OK = 0x00000000;
        private const uint MB_ICONERROR = 0x00000010;
        private const uint MB_SETFOREGROUND = 0x00010000;

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                string projectRoot = ResolveProjectRoot();
                string electronExe = Path.Combine(projectRoot, "node_modules", "electron", "dist", "electron.exe");

                if (!File.Exists(electronExe))
                {
                    string errorMsg = string.Format(
                        "Electron runtime not found at:\n{0}\n\nPlease ensure Agent Orbit dependencies are installed ('npm install').",
                        electronExe
                    );
                    MessageBox(IntPtr.Zero, errorMsg, "Agent Orbit", MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
                    return 1;
                }

                // Build argument string: "<projectRoot>" --replace [forwarded args...]
                StringBuilder argumentBuilder = new StringBuilder();
                string cleanRoot = projectRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                argumentBuilder.AppendFormat("\"{0}\" --replace", cleanRoot);

                if (args != null && args.Length > 0)
                {
                    for (int i = 0; i < args.Length; i++)
                    {
                        string arg = args[i];
                        if (string.IsNullOrEmpty(arg)) continue;

                        argumentBuilder.Append(" ");
                        if (arg.IndexOf(' ') >= 0 || arg.IndexOf('"') >= 0)
                        {
                            argumentBuilder.Append("\"").Append(arg.Replace("\"", "\\\"")).Append("\"");
                        }
                        else
                        {
                            argumentBuilder.Append(arg);
                        }
                    }
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = electronExe;
                psi.Arguments = argumentBuilder.ToString();
                psi.WorkingDirectory = cleanRoot;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;

                Process.Start(psi);
                return 0;
            }
            catch (Exception ex)
            {
                string exMsg = string.Format("Failed to launch Agent Orbit:\n{0}", ex.Message);
                MessageBox(IntPtr.Zero, exMsg, "Agent Orbit", MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
                return 1;
            }
        }

        private static string ResolveProjectRoot()
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                if (!string.IsNullOrEmpty(baseDir))
                {
                    // 1. Direct run from repository / install folder
                    string candidateElectron = Path.Combine(baseDir, "node_modules", "electron", "dist", "electron.exe");
                    if (File.Exists(candidateElectron))
                    {
                        return Path.GetFullPath(baseDir);
                    }

                    // 2. Sidecar .path pointer (written when installing Desktop shortcut via `npm run shortcut:desktop`)
                    string sidecarPath = Path.Combine(baseDir, "Agent Orbit.path");
                    if (File.Exists(sidecarPath))
                    {
                        string targetRoot = File.ReadAllText(sidecarPath, Encoding.UTF8).Trim();
                        if (!string.IsNullOrEmpty(targetRoot) && Directory.Exists(targetRoot))
                        {
                            return Path.GetFullPath(targetRoot);
                        }
                    }
                }
            }
            catch
            {
                // Fall through to common user-profile locations
            }

            // 3. Common user-profile clone locations
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string[] commonDirs = new string[]
            {
                Path.Combine(userProfile, "agent-orbit"),
                Path.Combine(userProfile, "code", "agent-orbit"),
                Path.Combine(userProfile, "Desktop", "code", "agent-orbit"),
                Path.Combine(userProfile, "source", "repos", "agent-orbit")
            };
            for (int i = 0; i < commonDirs.Length; i++)
            {
                if (File.Exists(Path.Combine(commonDirs[i], "node_modules", "electron", "dist", "electron.exe")))
                {
                    return Path.GetFullPath(commonDirs[i]);
                }
            }

            return Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        }
    }
}
