using System;
using System.Diagnostics;
using System.IO;

// Hephaestus Workbench 的轻量入口适配器。
// 工作台使用 --input/--output，现有分析器保留 -d/-o；适配器只负责参数转换和退出码传递。
internal static class PluginLauncher
{
    private static int Main(string[] args)
    {
        string input = GetValue(args, "--input");
        string output = GetValue(args, "--output");
        if (String.IsNullOrWhiteSpace(input))
        {
            Console.Error.WriteLine("插件调用错误：缺少 --input 日志路径。");
            return 2;
        }

        string analyzer = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "log_analyzer.exe");
        if (!File.Exists(analyzer))
        {
            Console.Error.WriteLine("插件安装错误：找不到 log_analyzer.exe。");
            return 3;
        }

        ProcessStartInfo startInfo = new ProcessStartInfo
        {
            FileName = analyzer,
            Arguments = "-d " + Quote(input) + (String.IsNullOrWhiteSpace(output) ? "" : " -o " + Quote(output)),
            WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory,
            UseShellExecute = false
        };

        using (Process process = Process.Start(startInfo))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static string GetValue(string[] args, string name)
    {
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (String.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[i + 1];
            }
        }
        return "";
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }
}
