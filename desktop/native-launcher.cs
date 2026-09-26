// Windows-only native-messaging entry point. Compiled using the .NET Framework
// compiler provided with Windows. This helper never opens or stores vault data.
// Electron initializes its console before JavaScript runs; set the opt-out in
// the child environment so no startup CRLF contaminates Chrome's binary stream.
using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

internal static class NativeLauncher
{
    private static int Main(string[] args)
    {
        if (args.Length < 1 || args.Length > 2 ||
            !Regex.IsMatch(args[0], @"\Achrome-extension://[a-p]{32}/\z") ||
            (args.Length == 2 && !Regex.IsMatch(args[1], @"\A--parent-window=[0-9]{1,20}\z")))
            return 1;

        try
        {
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            string executable = Path.Combine(directory, "secondHand.exe");
            if (!File.Exists(executable)) return 1;
            var start = new ProcessStartInfo
            {
                FileName = executable,
                // Only characters allowed by the strict patterns above reach
                // the child command line; no shell or external command runs.
                Arguments = String.Join(" ", args),
                WorkingDirectory = directory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.EnvironmentVariables["ELECTRON_NO_ATTACH_CONSOLE"] = "1";
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            using (var child = new Process { StartInfo = start })
            {
                if (!child.Start()) return 1;
                // BaseStream and OpenStandard* avoid StreamReader/Writer text
                // transformations, BOMs, and CRLF conversion of length bytes.
                Task input = Task.Run(async delegate
                {
                    try { await Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream); }
                    catch (IOException) { }
                    finally { try { child.StandardInput.BaseStream.Close(); } catch { } }
                });
                Task output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                Task errors = child.StandardError.BaseStream.CopyToAsync(Stream.Null);
                child.WaitForExit();
                output.GetAwaiter().GetResult();
                errors.GetAwaiter().GetResult();
                // Do not wait on browser input after the child exits. Chrome
                // may keep that pipe open until it observes our process exit.
                return child.ExitCode;
            }
        }
        catch
        {
            // Stdout is reserved entirely for framed native messages. Avoid
            // diagnostics containing local paths or applicant information.
            return 1;
        }
    }
}
