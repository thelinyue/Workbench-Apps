package main

import (
	_ "embed"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// editorHTML 是规则编辑器的完整离线页面。页面不依赖网络资源，确保工作台在
// 无网络环境下也能完成规则导入、校验和导出。
//
//go:embed editor.html
var editorHTML []byte

type options struct {
	caseID     string
	inputPath  string
	outputPath string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "规则编辑器运行失败："+err.Error())
		os.Exit(1)
	}
}

// run 只在工作台指定的输出目录写入 report.html，不修改案例源文件和工作台配置。
// inputPath 当前仅用于遵守标准插件协议；规则内容由用户在页面中显式导入，避免
// 把日志压缩包误当成规则文件。
func run(args []string) error {
	opts, err := parseOptions(args)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(opts.outputPath, 0o755); err != nil {
		return fmt.Errorf("无法创建报告输出目录 %q：%w", opts.outputPath, err)
	}
	reportPath := filepath.Join(opts.outputPath, "report.html")
	if err := os.WriteFile(reportPath, editorHTML, 0o644); err != nil {
		return fmt.Errorf("无法写入规则编辑器页面 %q：%w", reportPath, err)
	}
	fmt.Printf("规则编辑器已生成：%s\n", reportPath)
	return nil
}

func parseOptions(args []string) (options, error) {
	var opts options
	flags := flag.NewFlagSet("rule-editor", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.StringVar(&opts.caseID, "case", "", "工作台案例标识")
	flags.StringVar(&opts.inputPath, "input", "", "工作台案例输入路径")
	flags.StringVar(&opts.outputPath, "output", "", "规则编辑器页面输出目录")
	if err := flags.Parse(args); err != nil {
		return options{}, err
	}
	opts.outputPath = strings.TrimSpace(opts.outputPath)
	if opts.outputPath == "" {
		return options{}, errors.New("缺少 --output 输出目录")
	}
	return opts, nil
}
