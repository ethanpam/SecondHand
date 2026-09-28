// Windows Chrome native-messaging host. Compiled with the .NET Framework that
// ships with Windows. This relay reads only the ephemeral local bridge session;
// the running Electron desktop remains the sole owner of the encrypted vault.
// Asked to open SecondHand while it isn't running, it starts the installed app.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class NativeLauncher
{
    private const int MaximumBytes = 65536;
    // The desktop app, installed in this relay's folder (package.json build.win).
    private const string AppExecutable = "secondHand.exe";
    private const uint DetachedProcess = 0x00000008;
    private const uint CreateNewProcessGroup = 0x00000200;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer
    {
        MaxJsonLength = MaximumBytes,
        RecursionLimit = 16
    };
    // openApp starts SecondHand at most once per relay; later ones get the same answer.
    private static bool appStartTried;
    private static string appStartFailure;

    private static int Main(string[] args)
    {
        if (args.Length < 1 || args.Length > 2 ||
            !Regex.IsMatch(args[0], @"\Achrome-extension://[a-p]{32}/\z") ||
            (args.Length == 2 && !Regex.IsMatch(args[1], @"\A--parent-window=[0-9]{1,20}\z")))
            return 1;
        string extensionId = args[0].Substring("chrome-extension://".Length, 32);
        try
        {
            using (Stream input = Console.OpenStandardInput())
            using (Stream output = Console.OpenStandardOutput())
            {
                while (true)
                {
                    byte[] bytes = ReadFrame(input, null);
                    if (bytes == null) return 0;
                    string id = "";
                    byte[] response;
                    try
                    {
                        Dictionary<string, object> request = AsObject(Json.DeserializeObject(Utf8.GetString(bytes)));
                        id = StringValue(request, "id");
                        if (!Regex.IsMatch(id, @"\A[A-Za-z0-9_-]{1,64}\z")) throw new IOException();
                        response = Answer(extensionId, request, id);
                    }
                    catch
                    {
                        if (!Regex.IsMatch(id, @"\A[A-Za-z0-9_-]{1,64}\z")) id = "";
                        response = Utf8.GetBytes(Json.Serialize(new Dictionary<string, object>
                        {
                            { "id", id }, { "ok", false },
                            { "error", "Open SecondHand, connect this extension, and unlock your local vault." }
                        }));
                    }
                    WriteFrame(output, response);
                }
            }
        }
        catch
        {
            // Never log native payloads, local paths, or bridge credentials.
            // Malformed/closed streams terminate and Chrome reports disconnect.
            return 1;
        }
    }

    // Relays a request to the running app. With the app closed, openApp starts it and anything else fails.
    private static byte[] Answer(string extensionId, Dictionary<string, object> request, string id)
    {
        string token;
        NamedPipeClientStream pipe = ConnectToApp(out token);
        if (pipe == null)
        {
            // openApp carries only its id and type.
            if (StringValue(request, "type") != "openApp" || request.Count != 2) throw new IOException();
            return OpenApp(id);
        }
        using (pipe) return Relay(pipe, token, extensionId, request, id);
    }

    // The running app's pipe, or null when SecondHand can't be reached: no bridge session (the app is
    // closed), one that can't be read, or no app answering on its pipe (a session left by a crash).
    private static NamedPipeClientStream ConnectToApp(out string token)
    {
        string pipeName;
        token = null;
        try { pipeName = ReadSession(out token); }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
        catch (ArgumentException) { return null; }
        var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            pipe.Connect(5000);
            return pipe;
        }
        catch (TimeoutException) { pipe.Dispose(); return null; }
        catch (IOException) { pipe.Dispose(); return null; }
        catch (UnauthorizedAccessException) { pipe.Dispose(); return null; }
    }

    // The session the running app wrote: its token, and the name of its pipe.
    private static string ReadSession(out string token)
    {
        string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (String.IsNullOrEmpty(local)) local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string sessionPath = Path.Combine(local, "SecondHand", "bridge-session.json");
        byte[] sessionBytes;
        using (var file = new FileStream(sessionPath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (file.Length < 2 || file.Length > 4096) throw new IOException();
            sessionBytes = new byte[(int)file.Length];
            ReadExact(file, sessionBytes, 0, sessionBytes.Length, false, null);
        }
        Dictionary<string, object> session = AsObject(Json.DeserializeObject(Utf8.GetString(sessionBytes)));
        object version;
        if (!session.TryGetValue("version", out version) || !(version is int) || (int)version != 1) throw new IOException();
        token = StringValue(session, "token");
        string socket = StringValue(session, "socketPath");
        if (!Regex.IsMatch(token, @"\A[0-9a-f]{64}\z")) throw new IOException();
        const string prefix = @"\\.\pipe\";
        if (!socket.StartsWith(prefix, StringComparison.Ordinal)) throw new IOException();
        string pipeName = socket.Substring(prefix.Length);
        // Explicitly forbid remote pipes, path traversal, and arbitrary names.
        if (!Regex.IsMatch(pipeName, @"\Asecondhand-[0-9a-f]{24}\z")) throw new IOException();
        return pipeName;
    }

    private static byte[] Relay(NamedPipeClientStream pipe, string token, string extensionId, Dictionary<string, object> request, string id)
    {
        byte[] envelope = Utf8.GetBytes(Json.Serialize(new Dictionary<string, object>
        {
            { "token", token }, { "extensionId", extensionId }, { "request", request }
        }));
        WriteFrame(pipe, envelope);
        var deadline = Stopwatch.StartNew();
        byte[] response = ReadFrame(pipe, deadline);
        if (response == null) throw new IOException();
        Dictionary<string, object> parsed = AsObject(Json.DeserializeObject(Utf8.GetString(response)));
        object ok;
        if (StringValue(parsed, "id") != id || !parsed.TryGetValue("ok", out ok) || !(ok is bool)) throw new IOException();
        return response;
    }

    // openApp with SecondHand closed. Chrome starts a relay for each request, so two quick clicks may each
    // start the app; the app's single-instance lock keeps one running and brings its window forward.
    private static byte[] OpenApp(string id)
    {
        if (!appStartTried)
        {
            try { StartApp(); }
            catch (Win32Exception error) { appStartFailure = "SecondHand could not be started (Windows error " + error.NativeErrorCode + ")."; }
            appStartTried = true;
        }
        var answer = new Dictionary<string, object> { { "id", id } };
        if (appStartFailure == null)
        {
            answer.Add("ok", true);
            answer.Add("data", new Dictionary<string, object> { { "opened", "launched" } });
        }
        else
        {
            answer.Add("ok", false);
            answer.Add("error", appStartFailure);
        }
        return Utf8.GetBytes(Json.Serialize(answer));
    }

    // Starts the installed app from this relay's own folder, as its own process: no arguments, none of the
    // relay's handles (Chrome's pipes stay here), and the relay's environment less the test settings, which
    // the macOS host drops too. Nothing from the request reaches it.
    private static void StartApp()
    {
        string folder = Path.GetDirectoryName(Assembly.GetEntryAssembly().Location);
        string app = Path.Combine(folder, AppExecutable);
        Environment.SetEnvironmentVariable("SECONDHAND_TEST_MODE", null);
        Environment.SetEnvironmentVariable("SECONDHAND_TEST_USER_DATA", null);
        var startup = new StartupInfo();
        startup.Size = Marshal.SizeOf(typeof(StartupInfo));
        ProcessInformation process;
        if (!CreateProcess(app, new StringBuilder("\"" + app + "\""), IntPtr.Zero, IntPtr.Zero, false,
                DetachedProcess | CreateNewProcessGroup, IntPtr.Zero, folder, ref startup, out process))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        CloseHandle(process.Thread);
        CloseHandle(process.Process);
    }

    private static Dictionary<string, object> AsObject(object value)
    {
        var result = value as Dictionary<string, object>;
        if (result == null) throw new IOException();
        return result;
    }

    private static string StringValue(Dictionary<string, object> value, string key)
    {
        object result;
        if (!value.TryGetValue(key, out result) || !(result is string)) throw new IOException();
        return (string)result;
    }

    private static byte[] ReadFrame(Stream stream, Stopwatch deadline)
    {
        byte[] header = new byte[4];
        if (!ReadExact(stream, header, 0, 4, true, deadline)) return null;
        uint length = (uint)header[0] | ((uint)header[1] << 8) | ((uint)header[2] << 16) | ((uint)header[3] << 24);
        if (length < 2 || length > MaximumBytes) throw new IOException();
        byte[] data = new byte[(int)length];
        ReadExact(stream, data, 0, data.Length, false, deadline);
        return data;
    }

    private static bool ReadExact(Stream stream, byte[] buffer, int offset, int length, bool allowEnd, Stopwatch deadline)
    {
        int received = 0;
        while (received < length)
        {
            int count;
            if (deadline == null) count = stream.Read(buffer, offset + received, length - received);
            else
            {
                int remaining = 125000 - (int)deadline.ElapsedMilliseconds;
                if (remaining <= 0) throw new IOException();
                Task<int> operation = stream.ReadAsync(buffer, offset + received, length - received);
                if (!operation.Wait(remaining)) throw new IOException();
                count = operation.GetAwaiter().GetResult();
            }
            if (count == 0)
            {
                if (allowEnd && received == 0) return false;
                throw new IOException();
            }
            received += count;
        }
        return true;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    // STARTUPINFOW: all zero but its size, so the app opens with its own window settings and no handles.
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, Width, Height, Columns, Rows, FillAttribute, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, StandardInput, StandardOutput, StandardError;
    }

    // PROCESS_INFORMATION
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public int ProcessId, ThreadId;
    }

    private static void WriteFrame(Stream stream, byte[] bytes)
    {
        if (bytes.Length < 2 || bytes.Length > MaximumBytes) throw new IOException();
        uint length = (uint)bytes.Length;
        byte[] header = { (byte)length, (byte)(length >> 8), (byte)(length >> 16), (byte)(length >> 24) };
        stream.Write(header, 0, header.Length);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }
}
