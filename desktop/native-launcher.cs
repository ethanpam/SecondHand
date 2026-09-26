// Windows Chrome native-messaging host. Compiled with the .NET Framework that
// ships with Windows. This relay reads only the ephemeral local bridge session;
// the running Electron desktop remains the sole owner of the encrypted vault.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class NativeLauncher
{
    private const int MaximumBytes = 65536;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer
    {
        MaxJsonLength = MaximumBytes,
        RecursionLimit = 16
    };

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
                        response = Relay(extensionId, request, id);
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

    private static byte[] Relay(string extensionId, Dictionary<string, object> request, string id)
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
        string token = StringValue(session, "token");
        string socket = StringValue(session, "socketPath");
        if (!Regex.IsMatch(token, @"\A[0-9a-f]{64}\z")) throw new IOException();
        const string prefix = @"\\.\pipe\";
        if (!socket.StartsWith(prefix, StringComparison.Ordinal)) throw new IOException();
        string pipeName = socket.Substring(prefix.Length);
        // Explicitly forbid remote pipes, path traversal, and arbitrary names.
        if (!Regex.IsMatch(pipeName, @"\Asecondhand-[0-9a-f]{24}\z")) throw new IOException();
        byte[] envelope = Utf8.GetBytes(Json.Serialize(new Dictionary<string, object>
        {
            { "token", token }, { "extensionId", extensionId }, { "request", request }
        }));
        using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
        {
            pipe.Connect(5000);
            WriteFrame(pipe, envelope);
            var deadline = Stopwatch.StartNew();
            byte[] response = ReadFrame(pipe, deadline);
            if (response == null) throw new IOException();
            Dictionary<string, object> parsed = AsObject(Json.DeserializeObject(Utf8.GetString(response)));
            object ok;
            if (StringValue(parsed, "id") != id || !parsed.TryGetValue("ok", out ok) || !(ok is bool)) throw new IOException();
            return response;
        }
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
