package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"html/template"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed config.json
var embeddedConfig []byte

//go:embed static/bootstrap.min.css
var bootstrapCSS []byte

//go:embed static/bootstrap.bundle.min.js
var bootstrapJS []byte

var (
	// 插件协议参数与旧版 -d/-o 保持兼容，便于工作台和命令行用户共用同一个 EXE。
	pluginCase   = flag.String("case", "", "工作台传入的案例标识")
	pluginInput  = flag.String("input", "", "工作台传入的日志目录或压缩包")
	pluginOutput = flag.String("output", "", "工作台传入的报告输出目录")
	targetPath   = flag.String("d", "", "指定目标路径或压缩包")
	reportOutput = flag.String("o", "", "指定报告输出目录")
	maxEntries   = flag.Int("n", 50, "每个关键词默认显示最新的最大条目数")
)

type Config struct {
	Version string       `json:"version"`
	Files   []FileConfig `json:"files"`
}

type FileConfig struct {
	Name     string    `json:"name"`
	Category string    `json:"category"`
	Keywords []Keyword `json:"keywords"`
	Order    int       `json:"-"`
}

type Keyword struct {
	Term             string   `json:"term"`
	Result           string   `json:"result"`
	IsRegex          bool     `json:"regex"`
	Severity         Severity `json:"severity"`
	ContextLines     int      `json:"context_lines"`
	ContextDirection string   `json:"context_direction"`
	SearchDirection  string   `json:"search_direction"`
	Order            int      `json:"-"`
	regex            *regexp.Regexp
}

type Severity string

const (
	SeverityCritical Severity = "critical"
	SeverityWarning  Severity = "warning"
	SeverityInfo     Severity = "info"
)

type Issue struct {
	Line         int
	Keyword      string
	Message      string
	Context      string
	ContextLines []ContextLine
	Severity     Severity
	RuleOrder    int
}

type ContextLine struct {
	Number int
	Text   string
	Hit    bool
}

type GroupedIssue struct {
	Keyword    string
	Message    string
	Severity   Severity
	Order      int
	Count      int
	Issues     []Issue
	ShowCount  int
	TotalCount int
	FirstLine  int
	LastLine   int
}

type Result struct {
	File            string
	Category        string
	GroupedIssues   []GroupedIssue
	SysInfo         *SysInfoSummary
	Memory          []MemoryModule
	BlockDevices    []BlockDeviceCard
	BlockDevicesRaw string
	Networks        []NetworkInterfaceCard
}

type DiagnosticItem struct {
	Severity Severity
	Message  string
	Files    []string
}

type BuildVersionCard struct {
	Application string
	Category    string
	File        string
	Version     string
	Timestamp   string
}

// ReportData 是报告模板的唯一输入模型，避免模板直接依赖分析过程中的临时数据。
type ReportData struct {
	Title             string
	AnalysisTime      string
	RuleVersion       string
	TargetPath        string
	SummaryItems      []DiagnosticItem
	DiagnosticSummary string
	DiagnosticClass   string
	DiagnosticTarget  string
	BuildVersions     []BuildVersionCard
	Memory            []MemoryModule
	BlockDevices      []BlockDeviceCard
	BlockDevicesPath  string
	Networks          []NetworkInterfaceCard
	Results           []Result
	Categories        []string
	Keywords          []string
	SysInfo           *SysInfoSummary
}

func main() {
	flag.Parse()
	// Hephaestus Workbench 使用 --input/--output 调用插件；空的 --case 允许
	// 旧版本工作台在尚未分配案例标识时继续运行，案例标识目前不影响分析结果。
	if *targetPath == "" && *pluginInput != "" {
		*targetPath = *pluginInput
	}
	if *reportOutput == "" && *pluginOutput != "" {
		*reportOutput = *pluginOutput
	}
	if *targetPath == "" {
		// 遍历未标记的位置参数
		for _, arg := range flag.Args() {
			if !strings.HasPrefix(arg, "-") {
				*targetPath = arg
				break
			}
		}
	}

	// 3. 路径有效性验证
	if *targetPath == "" {
		log.Fatal("必须提供日志路径（使用 -d 或直接输入路径）")
	} else if strings.HasPrefix(*targetPath, "-") {
		log.Fatal("路径参数不能以破折号开头")
	}

	startTime := time.Now()
	cfg := loadConfig()
	finalDir := preprocessTarget(*targetPath)
	decompressGzFiles(finalDir)
	results := analyzeFiles(finalDir, cfg)
	reportPath, err := resolveReportPath(finalDir, *reportOutput)
	if err != nil {
		log.Fatal("报告输出路径无效: ", err)
	}
	generateReport(results, cfg, reportPath, *maxEntries, finalDir, startTime)

	if absPath, err := filepath.Abs(reportPath); err == nil {
		absPath = filepath.ToSlash(absPath)
		fmt.Printf("\n\033[32m报告已生成至: %s\033[0m\n", absPath)
	} else {
		fmt.Printf("报告路径: %s\n", reportPath)
	}

	fmt.Printf("分析完成，总耗时: %.2f秒\n", time.Since(startTime).Seconds())
	fmt.Printf("当前程序版本1.0.0")
}

// resolveReportPath 保留旧版默认输出位置，同时允许工作台把完整报告输出到指定目录。
// outputDirectory 只表示目录，不接受 report.html 文件路径，避免报告资源散落到不同位置。
func resolveReportPath(finalDir, outputDirectory string) (string, error) {
	outputDirectory = strings.TrimSpace(outputDirectory)
	if outputDirectory == "" {
		return filepath.Join(finalDir, "report", "report.html"), nil
	}
	if strings.HasPrefix(outputDirectory, "-") {
		return "", errors.New("报告输出目录不能以短横线开头")
	}
	return filepath.Join(filepath.Clean(outputDirectory), "report.html"), nil
}

func preprocessTarget(target string) string {
	fi, err := os.Stat(target)
	if err != nil {
		log.Fatalf("路径访问错误: %v", err)
	}

	if !fi.IsDir() && (strings.HasSuffix(target, ".tgz") ||
		strings.HasSuffix(target, ".tar.gz") ||
		strings.HasSuffix(target, ".tgz.temp")) {

		base := filepath.Base(target)
		destDir := strings.TrimSuffix(base, filepath.Ext(base))
		for strings.Contains(destDir, ".") {
			destDir = strings.TrimSuffix(destDir, filepath.Ext(destDir))
		}
		destPath := filepath.Join(filepath.Dir(target), destDir)

		if err := decompressTgz(target, destPath); err != nil {
			log.Fatalf("TGZ解压失败: %v", err)
		}
		return destPath
	}
	return target
}

func decompressTgz(src, dest string) error {
	if !strings.HasPrefix(filepath.Clean(dest), filepath.VolumeName(dest)) {
		return fmt.Errorf("危险路径: %s", dest)
	}

	file, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("打开文件失败: %w", err)
	}
	defer file.Close()

	headerBuf := make([]byte, 512)
	if _, err := file.Read(headerBuf); err != nil {
		return fmt.Errorf("文件头读取失败: %w", err)
	}
	if !bytes.Equal(headerBuf[0:2], []byte{0x1f, 0x8b}) {
		return errors.New("非标准GZIP文件")
	}
	file.Seek(0, 0)

	gzReader, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("GZIP头解析失败: %w", err)
	}
	defer gzReader.Close()

	tarReader := tar.NewReader(gzReader)
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("TAR条目读取失败: %w", err)
		}

		targetPath := filepath.Join(dest, filepath.Clean(header.Name))
		if !strings.HasPrefix(targetPath, dest) {
			return fmt.Errorf("非法路径: %s", header.Name)
		}

		if header.FileInfo().IsDir() {
			if err := os.MkdirAll(targetPath, 0755); err != nil {
				return fmt.Errorf("目录创建失败: %w", err)
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return fmt.Errorf("父目录创建失败: %w", err)
		}
		outFile, err := os.OpenFile(targetPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, header.FileInfo().Mode())
		if err != nil {
			return fmt.Errorf("文件创建失败: %w", err)
		}

		buf := make([]byte, 32*1024)
		if _, err := io.CopyBuffer(outFile, tarReader, buf); err != nil {
			outFile.Close()
			return fmt.Errorf("文件写入失败: %w", err)
		}
		outFile.Close()
	}
	return nil
}

func loadConfig() *Config {
	var cfg Config
	if err := json.Unmarshal(embeddedConfig, &cfg); err != nil {
		log.Fatal("内置配置错误: ", err)
	}
	for i := range cfg.Files {
		cfg.Files[i].Order = i
	}

	for i := range cfg.Files {
		seen := make(map[string]bool)
		keywords := make([]Keyword, 0, len(cfg.Files[i].Keywords))
		for j, kw := range cfg.Files[i].Keywords {
			if strings.TrimSpace(kw.Term) == "" {
				log.Printf("规则警告：文件 %s 存在空关键词，已跳过", cfg.Files[i].Name)
				continue
			}
			if strings.TrimSpace(kw.Result) == "" {
				log.Printf("规则警告：文件 %s 的关键词 %s 没有问题描述", cfg.Files[i].Name, kw.Term)
			}
			if kw.ContextLines < 0 {
				log.Fatalf("规则错误：文件 %s 的关键词 %s 上下文行数不能为负数", cfg.Files[i].Name, kw.Term)
			}
			if kw.ContextDirection == "" {
				kw.ContextDirection = "down"
			}
			if kw.ContextDirection != "up" && kw.ContextDirection != "down" {
				log.Fatalf("规则错误：文件 %s 的关键词 %s 上下文方向必须是 up 或 down", cfg.Files[i].Name, kw.Term)
			}
			if kw.SearchDirection == "" {
				kw.SearchDirection = "down"
			}
			if kw.SearchDirection != "up" && kw.SearchDirection != "down" {
				log.Fatalf("规则错误：文件 %s 的关键词 %s 搜索方向必须是 up 或 down", cfg.Files[i].Name, kw.Term)
			}
			if !kw.IsRegex && (strings.Contains(kw.Term, ".*") || strings.Contains(kw.Term, ".+")) {
				log.Printf("规则警告：文件 %s 的关键词 %s 含有正则写法但 regex=false", cfg.Files[i].Name, kw.Term)
			}
			kw.Severity = normalizeSeverity(kw.Severity, kw.Term, kw.Result)
			kw.Order = j
			ruleKey := fmt.Sprintf("%s\x00%t\x00%s", kw.Term, kw.IsRegex, kw.Result)
			if seen[ruleKey] {
				log.Printf("规则警告：文件 %s 存在重复规则 %s，已跳过重复项", cfg.Files[i].Name, kw.Term)
				continue
			}
			seen[ruleKey] = true
			if kw.IsRegex {
				re, err := regexp.Compile(kw.Term)
				if err != nil {
					log.Fatalf("正则错误: %s - %v", kw.Term, err)
				}
				kw.regex = re
			}
			keywords = append(keywords, kw)
		}
		cfg.Files[i].Keywords = keywords
	}
	return &cfg
}

func normalizeSeverity(value Severity, term, result string) Severity {
	switch value {
	case SeverityCritical, SeverityWarning, SeverityInfo:
		return value
	}

	text := strings.ToLower(term + " " + result)
	criticalTerms := []string{"kernel", "崩溃", "smart", "坏道", "扇区", "ext4", "btrfs", "文件系统错误", "null pointer", "segfault", "general protection"}
	warningTerms := []string{"i/o", "io error", "timeout", "network", "网络", "空间不足", "no space", "reset", "只读", "read-only", "device not ready"}
	for _, keyword := range criticalTerms {
		if strings.Contains(text, keyword) {
			return SeverityCritical
		}
	}
	for _, keyword := range warningTerms {
		if strings.Contains(text, keyword) {
			return SeverityWarning
		}
	}
	return SeverityInfo
}

func decompressGzFiles(root string) {
	var wg sync.WaitGroup

	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			log.Printf("⚠️ 跳过路径 [%s] (错误: %v)", path, err)
			return nil
		}

		if !info.IsDir() && strings.HasSuffix(path, ".gz") {
			wg.Add(1)
			go func(p string) {
				defer wg.Done()
				dest := strings.TrimSuffix(p, ".gz")
				if _, err := os.Stat(dest); os.IsNotExist(err) {
					if err := decompress(p, dest); err != nil {
						log.Printf("解压失败 %s: %v", p, err)
					} else {
						log.Printf("解压完成: %s → %s", p, dest)
					}
				}
			}(path)
		}
		return nil
	})
	wg.Wait()
}

func decompress(src, dest string) error {
	gzFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer gzFile.Close()

	reader, err := gzip.NewReader(gzFile)
	if err != nil {
		return err
	}
	defer reader.Close()

	output, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer output.Close()

	_, err = io.Copy(output, reader)
	return err
}

func analyzeFiles(root string, cfg *Config) []Result {
	fileChan := make(chan string, 100)
	resultChan := make(chan Result, 100)

	workers := runtime.NumCPU() * 2
	var wg sync.WaitGroup
	wg.Add(workers)

	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for path := range fileChan {
				if fc := matchFileConfig(path, cfg); fc != nil {
					result := processFile(path, fc)
					if hasGroupedIssues(result.GroupedIssues) || result.SysInfo != nil || len(result.Memory) > 0 || result.BlockDevicesRaw != "" || len(result.BlockDevices) > 0 || len(result.Networks) > 0 {
						resultChan <- result
					}
				}
			}
		}()
	}

	go func() {
		filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				log.Printf("⚠️ 跳过路径 [%s] (错误: %v)", path, err)
				return nil
			}

			if !info.IsDir() {
				fileChan <- path
			}
			return nil
		})
		close(fileChan)
	}()

	go func() {
		wg.Wait()
		close(resultChan)
	}()

	var results []Result
	for res := range resultChan {
		results = append(results, res)
	}

	return sortResults(results, cfg)
}

func matchFileConfig(path string, cfg *Config) *FileConfig {
	base := filepath.Base(path)
	for _, fc := range cfg.Files {
		if strings.HasPrefix(base, fc.Name) {
			return &fc
		}
	}
	return nil
}

func processFile(path string, fc *FileConfig) Result {
	file, err := os.Open(path)
	if err != nil {
		log.Printf("文件打开失败: %s - %v", path, err)
		return Result{}
	}
	defer file.Close()

	content, err := io.ReadAll(file)
	if err != nil {
		log.Printf("文件读取失败: %s - %v", path, err)
		return Result{}
	}

	var sysInfo *SysInfoSummary
	var memory []MemoryModule
	var blockDevices []BlockDeviceCard
	var blockDevicesRaw string
	var networks []NetworkInterfaceCard
	if strings.EqualFold(filepath.Base(path), "sysinfo.json") {
		sysInfo = parseSysInfo(content)
	}
	if strings.EqualFold(filepath.Base(path), "lsblk.log") {
		blockDevices = parseLsblk(content)
		blockDevicesRaw = string(content)
	}
	memory = parseDmiMemory(content)
	if strings.EqualFold(filepath.Base(path), "ifconfig.log") {
		networks = parseIfconfig(content)
	}

	lines := bytes.Split(content, []byte{'\n'})
	var issues []Issue

	for _, kw := range fc.Keywords {
		if kw.SearchDirection == "up" {
			for i := len(lines) - 1; i >= 0; i-- {
				processLine(lines[i], i+1, fc, lines, &issues, &kw)
			}
		} else {
			for i := 0; i < len(lines); i++ {
				processLine(lines[i], i+1, fc, lines, &issues, &kw)
			}
		}
	}

	uniqueIssues := make([]Issue, 0, len(issues))
	seenIssues := make(map[string]bool)
	for _, issue := range issues {
		issueKey := fmt.Sprintf("%s\x00%d", issue.Keyword, issue.Line)
		if seenIssues[issueKey] {
			continue
		}
		seenIssues[issueKey] = true
		uniqueIssues = append(uniqueIssues, issue)
	}
	issues = uniqueIssues

	issueMap := make(map[string][]Issue)
	for _, issue := range issues {
		issueMap[issue.Keyword] = append(issueMap[issue.Keyword], issue)
	}

	var grouped []GroupedIssue
	seen := make(map[string]bool)
	for _, issue := range issues {
		if !seen[issue.Keyword] {
			groupIssues := issueMap[issue.Keyword]
			firstLine, lastLine := groupIssues[0].Line, groupIssues[0].Line
			severity := groupIssues[0].Severity
			order := groupIssues[0].RuleOrder
			for _, groupIssue := range groupIssues[1:] {
				if groupIssue.Line < firstLine {
					firstLine = groupIssue.Line
				}
				if groupIssue.Line > lastLine {
					lastLine = groupIssue.Line
				}
				if severityRank(groupIssue.Severity) > severityRank(severity) {
					severity = groupIssue.Severity
				}
				if groupIssue.RuleOrder < order {
					order = groupIssue.RuleOrder
				}
			}
			grouped = append(grouped, GroupedIssue{
				Keyword:    issue.Keyword,
				Message:    issue.Message,
				Severity:   severity,
				Order:      order,
				Count:      len(groupIssues),
				Issues:     groupIssues,
				ShowCount:  len(groupIssues),
				TotalCount: len(groupIssues),
				FirstLine:  firstLine,
				LastLine:   lastLine,
			})
			seen[issue.Keyword] = true
		}
	}
	sort.SliceStable(grouped, func(i, j int) bool {
		if severityRank(grouped[i].Severity) != severityRank(grouped[j].Severity) {
			return severityRank(grouped[i].Severity) > severityRank(grouped[j].Severity)
		}
		if len(grouped[i].Issues) != len(grouped[j].Issues) {
			return len(grouped[i].Issues) > len(grouped[j].Issues)
		}
		return grouped[i].Order < grouped[j].Order
	})

	return Result{
		File:            path,
		Category:        fc.Category,
		GroupedIssues:   grouped,
		SysInfo:         sysInfo,
		Memory:          memory,
		BlockDevices:    blockDevices,
		BlockDevicesRaw: blockDevicesRaw,
		Networks:        networks,
	}
}

func severityRank(severity Severity) int {
	switch severity {
	case SeverityCritical:
		return 3
	case SeverityWarning:
		return 2
	default:
		return 1
	}
}

func processLine(line []byte, lineNum int, fc *FileConfig, allLines [][]byte, issues *[]Issue, kw *Keyword) {
	var jsonData map[string]interface{}
	searchContent := string(line)
	if json.Unmarshal(line, &jsonData) == nil {
		if jsonStr, err := json.Marshal(jsonData); err == nil {
			searchContent = string(jsonStr)
		}
	}

	var found bool
	if kw.IsRegex {
		found = kw.regex.MatchString(searchContent)
	} else {
		found = strings.Contains(searchContent, kw.Term)
	}

	if found {
		contextLines := getContextLineData(lineNum, kw.ContextLines, kw.ContextDirection, allLines)
		contextText := make([]string, 0, len(contextLines))
		for _, contextLine := range contextLines {
			contextText = append(contextText, contextLine.Text)
		}

		*issues = append(*issues, Issue{
			Line:         lineNum,
			Keyword:      kw.Term,
			Message:      kw.Result,
			Context:      strings.Join(contextText, "\n"),
			ContextLines: contextLines,
			Severity:     kw.Severity,
			RuleOrder:    kw.Order,
		})
	}
}

func getContextLineData(currentLine int, lines int, direction string, allLines [][]byte) []ContextLine {
	currentIndex := currentLine - 1
	start, end := currentIndex, currentIndex+1
	if direction == "up" {
		start = max(0, currentIndex-lines)
	} else {
		end = min(len(allLines), currentIndex+lines+1)
	}

	context := make([]ContextLine, 0, end-start)
	for i := start; i < end; i++ {
		context = append(context, ContextLine{Number: i + 1, Text: string(allLines[i]), Hit: i == currentIndex})
	}
	return context
}

func getContextLines(currentLine int, lines int, direction string, allLines [][]byte) []string {
	lineData := getContextLineData(currentLine, lines, direction, allLines)
	context := make([]string, 0, len(lineData))
	for _, line := range lineData {
		context = append(context, line.Text)
	}
	return context
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func sortResults(results []Result, cfg *Config) []Result {
	orderMap := make(map[string]int)
	for _, fc := range cfg.Files {
		orderMap[fc.Name] = fc.Order
	}

	sorted := make([]Result, len(results))
	copy(sorted, results)

	sort.SliceStable(sorted, func(i, j int) bool {
		iOrder := getFileOrder(sorted[i].File, orderMap)
		jOrder := getFileOrder(sorted[j].File, orderMap)

		if iOrder == jOrder {
			return sorted[i].File < sorted[j].File
		}
		return iOrder < jOrder
	})

	return sorted
}

func getFileOrder(path string, orderMap map[string]int) int {
	base := filepath.Base(path)
	for name, order := range orderMap {
		if strings.HasPrefix(base, name) {
			return order
		}
	}
	return len(orderMap) + 1
}

func hasGroupedIssues(groups []GroupedIssue) bool {
	for _, group := range groups {
		if len(group.Issues) > 0 {
			return true
		}
	}
	return false
}

func applyMaxEntries(results []Result, maxEntries int) []Result {
	limitedResults := make([]Result, len(results))

	for i, res := range results {
		limited := res
		limited.GroupedIssues = make([]GroupedIssue, len(res.GroupedIssues))

		for j, group := range res.GroupedIssues {
			limitedGroup := group
			limitedGroup.TotalCount = len(group.Issues)
			if len(group.Issues) > maxEntries {
				// 默认保留最新命中，避免旧日志占满报告；展示时恢复时间/行号顺序。
				latest := append([]Issue(nil), group.Issues...)
				sort.SliceStable(latest, func(a, b int) bool {
					return latest[a].Line > latest[b].Line
				})
				limitedGroup.Issues = latest[:maxEntries]
				sort.SliceStable(limitedGroup.Issues, func(a, b int) bool {
					return limitedGroup.Issues[a].Line < limitedGroup.Issues[b].Line
				})
				limitedGroup.ShowCount = maxEntries
			} else {
				limitedGroup.ShowCount = len(group.Issues)
			}
			limited.GroupedIssues[j] = limitedGroup
		}
		limitedResults[i] = limited
	}
	return limitedResults
}

func generateReport(results []Result, cfg *Config, outputPath string, maxEntries int, target string, startTime time.Time) {
	reportDir := filepath.Dir(outputPath)
	if err := os.MkdirAll(reportDir, 0755); err != nil {
		log.Fatal("创建报告目录失败: ", err)
	}

	staticDir := filepath.Join(reportDir, "static")
	if err := os.MkdirAll(staticDir, 0755); err != nil {
		log.Fatal("创建静态文件目录失败: ", err)
	}
	if err := os.WriteFile(filepath.Join(staticDir, "bootstrap.min.css"), bootstrapCSS, 0644); err != nil {
		log.Fatal("写入CSS文件失败: ", err)
	}
	if err := os.WriteFile(filepath.Join(staticDir, "bootstrap.bundle.min.js"), bootstrapJS, 0644); err != nil {
		log.Fatal("写入JS文件失败: ", err)
	}

	tmpl, err := template.New("report").Funcs(template.FuncMap{"split": strings.Split, "smartFocus": focusSmartAttributes, "smartRiskReminder": smartRiskReminder, "smartHasRisk": smartHasRisk}).Parse(dashboardReportTemplate)
	if err != nil {
		log.Fatal("模板解析失败: ", err)
	}

	file, err := os.Create(outputPath)
	if err != nil {
		log.Fatal("创建报告文件失败: ", err)
	}
	defer file.Close()

	reportResults := removeBuildVersionGroups(results)
	reportResults = removeStructuredResults(reportResults)
	limitedResults := applyMaxEntries(reportResults, maxEntries)
	sysInfo := firstSysInfo(results)
	if sysInfo != nil && sysInfo.Model == "" {
		sysInfo.Model = extractDMIModel(results)
	}
	blockDevicesPath := writeStructuredHTML(reportDir, "lsblk.html", extractBlockDevicesRaw(results))
	ruleVersion := cfg.Version
	if strings.TrimSpace(ruleVersion) == "" {
		ruleVersion = "内置规则 v1.0.0"
	}
	diagnosticTargetID := diagnosticTarget(limitedResults, sysInfo)
	if diagnosticTargetID == "" && (hasDiskFault(results, sysInfo) || hasFilesystemFault(results)) {
		log.Printf("快速诊断结论无法定位到具体证据，详情按钮将隐藏")
	}
	data := ReportData{
		Title:             "系统日志诊断报告",
		AnalysisTime:      startTime.Format("2006-01-02 15:04:05"),
		RuleVersion:       ruleVersion,
		TargetPath:        target,
		SummaryItems:      buildSummaryItems(reportResults),
		DiagnosticSummary: buildDiagnosticSummary(results, sysInfo),
		DiagnosticClass:   diagnosticClass(results, sysInfo),
		DiagnosticTarget:  diagnosticTargetID,
		BuildVersions:     extractBuildVersions(results),
		Memory:            extractMemoryModules(results),
		BlockDevices:      extractBlockDevices(results),
		BlockDevicesPath:  blockDevicesPath,
		Networks:          extractNetworks(results),
		Results:           limitedResults,
		Categories:        reportCategories(reportResults),
		Keywords:          reportKeywords(reportResults),
		SysInfo:           sysInfo,
	}
	if err := tmpl.Execute(file, data); err != nil {
		log.Fatal("生成报告失败: ", err)
	}

	log.Printf("报告文件路径: %s", outputPath)
	if fi, err := os.Stat(outputPath); err == nil {
		log.Printf("文件大小: %.2f KB", float64(fi.Size())/1024)
	}
}

// writeStructuredText 将大段结构化原文放到独立静态文件，避免首次打开报告时解析数 MB 的日志文本。
func writeStructuredText(reportDir, name, content string) string {
	if content == "" {
		return ""
	}
	dir := filepath.Join(reportDir, "structured")
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Printf("创建结构化日志目录失败：%v", err)
		return ""
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
		log.Printf("写入结构化日志文件失败：%s：%v", name, err)
		return ""
	}
	return filepath.ToSlash(filepath.Join("structured", name))
}

// writeStructuredHTML 将大段结构化原文包装为独立 HTML，确保 iframe 内文字具备清晰的字号、颜色和滚动体验。
func writeStructuredHTML(reportDir, name, content string) string {
	if content == "" {
		return ""
	}
	dir := filepath.Join(reportDir, "structured")
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Printf("创建结构化日志目录失败：%v", err)
		return ""
	}
	document := `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>html,body{margin:0;background:#0f172a;color:#e2e8f0}pre{box-sizing:border-box;margin:0;padding:16px;font:14px/1.65 Consolas,"Cascadia Code",monospace;white-space:pre;overflow:auto;min-height:100vh}</style><pre>` + template.HTMLEscapeString(content) + `</pre></html>`
	if err := os.WriteFile(filepath.Join(dir, name), []byte(document), 0644); err != nil {
		log.Printf("写入结构化日志文件失败：%s：%v", name, err)
		return ""
	}
	return filepath.ToSlash(filepath.Join("structured", name))
}

func isBuildVersionGroup(group GroupedIssue) bool {
	return strings.EqualFold(strings.TrimSpace(group.Keyword), "Build version") || strings.Contains(strings.ToLower(group.Message), "构建版本")
}

func removeBuildVersionGroups(results []Result) []Result {
	filtered := make([]Result, 0, len(results))
	for _, result := range results {
		copyResult := result
		copyResult.GroupedIssues = make([]GroupedIssue, 0, len(result.GroupedIssues))
		for _, group := range result.GroupedIssues {
			if !isBuildVersionGroup(group) {
				copyResult.GroupedIssues = append(copyResult.GroupedIssues, group)
			}
		}
		if len(copyResult.GroupedIssues) > 0 {
			filtered = append(filtered, copyResult)
		}
	}
	return filtered
}

func removeStructuredResults(results []Result) []Result {
	filtered := make([]Result, 0, len(results))
	for _, result := range results {
		if strings.EqualFold(filepath.Base(result.File), "sysinfo.json") || strings.EqualFold(filepath.Base(result.File), "lsblk.log") || strings.HasPrefix(strings.ToLower(filepath.Base(result.File)), "lspci") || strings.EqualFold(filepath.Base(result.File), "ifconfig.log") {
			continue
		}
		copyResult := result
		copyResult.GroupedIssues = make([]GroupedIssue, 0, len(result.GroupedIssues))
		for _, group := range result.GroupedIssues {
			if strings.Contains(group.Message, "内存信息") {
				continue
			}
			copyResult.GroupedIssues = append(copyResult.GroupedIssues, group)
		}
		if len(copyResult.GroupedIssues) > 0 {
			filtered = append(filtered, copyResult)
		}
	}
	return filtered
}

func buildDiagnosticSummary(results []Result, sysInfo *SysInfoSummary) string {
	diskFault := hasDiskFault(results, sysInfo)
	filesystemFault := hasFilesystemFault(results)
	if diskDetail := diskSmartRiskSummary(sysInfo); diskDetail != "" {
		if filesystemFault {
			return diskDetail + "，同时检测到文件系统故障，建议优先检查硬盘 SMART 和文件系统错误记录。"
		}
		return diskDetail + "，建议优先检查硬盘健康状态。"
	}
	if logDetail := diskConnectionFaultSummary(results); logDetail != "" {
		if filesystemFault {
			return logDetail + "，同时检测到文件系统故障，建议优先检查硬盘连接和文件系统错误记录。"
		}
		return logDetail + "，建议优先检查硬盘连接、供电和系统日志。"
	}
	switch {
	case diskFault && filesystemFault:
		return "同时检测到硬盘故障风险和文件系统故障，建议优先检查硬盘 SMART、系统日志和文件系统错误记录。"
	case diskFault:
		return "检测到硬盘故障风险，暂未检测到明确的文件系统故障，建议优先检查硬盘 SMART 和 I/O 错误。"
	case filesystemFault:
		return "检测到文件系统故障，暂未检测到明确的硬盘故障风险，建议优先检查 EXT4/BTRFS 错误及只读挂载情况。"
	default:
		return "暂未检测到硬盘故障或文件系统故障。"
	}
}

func diskConnectionFaultSummary(results []Result) string {
	for _, result := range results {
		for _, group := range result.GroupedIssues {
			text := strings.ToLower(group.Keyword + " " + group.Message)
			if strings.Contains(text, "sata接触不良") || strings.Contains(text, "硬盘故障") {
				return "检测到 SATA 接触不良或硬盘故障风险"
			}
		}
	}
	return ""
}

// diskSmartRiskSummary 将 SMART 关键属性的非零 RAW 值直接放入首屏结论，帮助工程师无需展开卡片即可判断风险来源。
func diskSmartRiskSummary(sysInfo *SysInfoSummary) string {
	if sysInfo == nil {
		return ""
	}
	for _, disk := range sysInfo.Disks {
		var risks []string
		for _, smart := range disk.Smart {
			if smart.ID != 5 && smart.ID != 197 && smart.ID != 198 {
				continue
			}
			raw, err := strconv.ParseInt(strings.TrimSpace(smart.Raw), 10, 64)
			if err != nil || raw <= 0 {
				continue
			}
			name := smart.Name
			if name == "" {
				name = smartAttributeName(smart.ID)
			}
			risks = append(risks, fmt.Sprintf("%s（ID %d）RAW=%d", name, smart.ID, raw))
		}
		if len(risks) > 0 {
			label := disk.Name
			if label == "" {
				label = disk.Label
			}
			if label == "" {
				label = "未命名硬盘"
			}
			return fmt.Sprintf("检测到硬盘“%s”的 SMART 风险：%s", label, strings.Join(risks, "、"))
		}
	}
	return ""
}

func smartAttributeName(id int) string {
	switch id {
	case 5:
		return "重映射扇区"
	case 197:
		return "待处理坏扇区"
	case 198:
		return "不可修复扇区"
	default:
		return "SMART 属性"
	}
}

func diagnosticClass(results []Result, sysInfo *SysInfoSummary) string {
	diskFault := hasDiskFault(results, sysInfo)
	filesystemFault := hasFilesystemFault(results)
	if diskFault && filesystemFault {
		return "diagnostic-critical"
	}
	if diskFault {
		return "diagnostic-disk"
	}
	if filesystemFault {
		return "diagnostic-filesystem"
	}
	return "diagnostic-ok"
}

const (
	diagnosticDiskTargetPrefix  = "diagnosticDisk-"
	diagnosticIssueTargetPrefix = "diagnosticIssue-"
)

// diagnosticTarget 返回与报告模板中稳定 ID 对应的首个关键证据目标。
// 目标顺序必须与快速诊断结论保持一致：SMART、磁盘日志、文件系统日志。
// 这里使用最终渲染的 limitedResults，避免过滤或截断后出现悬空链接。
func diagnosticTarget(results []Result, sysInfo *SysInfoSummary) string {
	if target := smartDiagnosticTarget(sysInfo); target != "" {
		return target
	}
	if target := issueDiagnosticTarget(results, func(text string) bool {
		for _, token := range []string{"smart", "nvme", "sata", "i/o error", "sector", "硬盘", "磁盘"} {
			if strings.Contains(text, token) {
				return true
			}
		}
		return false
	}); target != "" {
		return target
	}
	return issueDiagnosticTarget(results, func(text string) bool {
		for _, token := range []string{"ext4-fs", "ext4文件系统", "btrfs error", "只读文件系统", "read-only file system", "文件系统错误"} {
			if strings.Contains(text, token) {
				return true
			}
		}
		return false
	})
}

func smartDiagnosticTarget(sysInfo *SysInfoSummary) string {
	if sysInfo == nil {
		return ""
	}
	for diskIndex, disk := range sysInfo.Disks {
		for _, smart := range disk.Smart {
			if (smart.ID == 5 || smart.ID == 197 || smart.ID == 198) && smart.Status == "风险" {
				return fmt.Sprintf("%s%d", diagnosticDiskTargetPrefix, diskIndex)
			}
		}
	}
	return ""
}

func issueDiagnosticTarget(results []Result, matches func(string) bool) string {
	for resultIndex, result := range results {
		for groupIndex, group := range result.GroupedIssues {
			if group.Severity == SeverityInfo {
				continue
			}
			text := strings.ToLower(group.Keyword + " " + group.Message)
			if matches(text) {
				return fmt.Sprintf("%s%d-%d", diagnosticIssueTargetPrefix, resultIndex, groupIndex)
			}
		}
	}
	return ""
}

func hasDiskFault(results []Result, sysInfo *SysInfoSummary) bool {
	if sysInfo != nil {
		for _, disk := range sysInfo.Disks {
			for _, smart := range disk.Smart {
				if smart.ID == 5 || smart.ID == 197 || smart.ID == 198 {
					if smart.Status == "风险" {
						return true
					}
				}
			}
		}
	}
	for _, result := range results {
		for _, group := range result.GroupedIssues {
			text := strings.ToLower(group.Keyword + " " + group.Message)
			for _, token := range []string{"smart", "nvme", "sata", "i/o error", "sector", "硬盘", "磁盘"} {
				if strings.Contains(text, token) && group.Severity != SeverityInfo {
					return true
				}
			}
		}
	}
	return false
}

func hasFilesystemFault(results []Result) bool {
	for _, result := range results {
		for _, group := range result.GroupedIssues {
			text := strings.ToLower(group.Keyword + " " + group.Message)
			for _, token := range []string{"ext4-fs", "ext4文件系统", "btrfs error", "只读文件系统", "read-only file system", "文件系统错误"} {
				if strings.Contains(text, token) {
					return true
				}
			}
		}
	}
	return false
}

func extractBuildVersions(results []Result) []BuildVersionCard {
	type versionCandidate struct {
		card  BuildVersionCard
		rank  int
		stamp time.Time
		line  int
	}
	candidates := make(map[string]versionCandidate)
	for _, result := range results {
		var latestVersion, latestTimestamp string
		var latestTime time.Time
		latestLine := -1
		for _, group := range result.GroupedIssues {
			if !isBuildVersionGroup(group) {
				continue
			}
			for _, issue := range group.Issues {
				for _, line := range issue.ContextLines {
					if line.Hit {
						if value := cleanBuildVersion(line.Text); value != "" {
							stamp, ok := extractLogTimestamp(line.Text)
							isNewer := (!ok && latestTimestamp == "" && issue.Line >= latestLine) || (ok && (latestTimestamp == "" || stamp.After(latestTime)))
							if isNewer {
								latestVersion = value
								latestLine = issue.Line
								if ok {
									latestTime = stamp
									latestTimestamp = stamp.Format("2006-01-02 15:04:05")
								}
							}
						}
					}
				}
			}
		}
		if latestVersion != "" {
			card := BuildVersionCard{Application: buildVersionApplication(result.File), Category: result.Category, File: result.File, Version: latestVersion, Timestamp: latestTimestamp}
			candidate := versionCandidate{card: card, rank: buildVersionSourceRank(result.File), stamp: latestTime, line: latestLine}
			key := card.Application
			previous, exists := candidates[key]
			if !exists || candidate.rank < previous.rank || (candidate.rank == previous.rank && (candidate.stamp.After(previous.stamp) || (candidate.stamp.Equal(previous.stamp) && candidate.line > previous.line))) {
				candidates[key] = candidate
			}
		}
	}
	keys := make([]string, 0, len(candidates))
	for key := range candidates {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	versions := make([]BuildVersionCard, 0, len(keys))
	for _, key := range keys {
		versions = append(versions, candidates[key].card)
	}
	return versions
}

func buildVersionApplication(path string) string {
	base := filepath.Base(path)
	if index := strings.Index(base, ".slog"); index >= 0 {
		return base[:index]
	}
	return base
}

func buildVersionSourceRank(path string) int {
	base := filepath.Base(path)
	if strings.HasSuffix(base, ".slog") {
		return 0
	}
	if match := regexp.MustCompile(`\.slog\.(\d+)$`).FindStringSubmatch(base); len(match) > 1 {
		var rank int
		if _, err := fmt.Sscanf(match[1], "%d", &rank); err == nil {
			return rank
		}
	}
	return 1000
}

func extractLogTimestamp(line string) (time.Time, bool) {
	patterns := []string{`\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}`, `\d{4}/\d{2}/\d{2}[ T]\d{2}:\d{2}:\d{2}`}
	layouts := []string{"2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006/01/02 15:04:05", "2006/01/02T15:04:05"}
	for _, pattern := range patterns {
		match := regexp.MustCompile(pattern).FindString(line)
		if match == "" {
			continue
		}
		for _, layout := range layouts {
			if stamp, err := time.ParseInLocation(layout, match, time.Local); err == nil {
				return stamp, true
			}
		}
	}
	return time.Time{}, false
}

func cleanBuildVersion(line string) string {
	line = strings.TrimSpace(line)
	lower := strings.ToLower(line)
	if index := strings.Index(lower, "build version"); index >= 0 {
		line = strings.TrimSpace(line[index+len("build version"):])
		line = strings.TrimLeft(line, ":= -")
	}
	return strings.TrimSpace(line)
}

func firstSysInfo(results []Result) *SysInfoSummary {
	for _, result := range results {
		if result.SysInfo != nil {
			return result.SysInfo
		}
	}
	return nil
}

func extractDMIModel(results []Result) string {
	const marker = "DMI: UGREEN"
	for _, result := range results {
		for _, group := range result.GroupedIssues {
			if !strings.Contains(strings.ToLower(group.Keyword+" "+group.Message), "dmi: ugreen") && !strings.Contains(strings.ToLower(group.Message), "设备型号") {
				continue
			}
			for _, issue := range group.Issues {
				for _, line := range issue.ContextLines {
					if !line.Hit {
						continue
					}
					text := strings.TrimSpace(line.Text)
					index := strings.Index(strings.ToLower(text), strings.ToLower(marker))
					if index < 0 {
						continue
					}
					model := strings.TrimSpace(text[index+len(marker):])
					model = strings.TrimSpace(strings.TrimLeft(model, ":=- "))
					if strings.HasPrefix(strings.ToUpper(model), "UGREEN ") {
						model = strings.TrimSpace(model[len("UGREEN "):])
					}
					if model != "" {
						return model
					}
				}
			}
		}
	}
	return ""
}

func buildSummaryItems(results []Result) []DiagnosticItem {
	items := make([]DiagnosticItem, 0)
	for _, result := range results {
		for _, group := range result.GroupedIssues {
			if group.Severity == SeverityInfo {
				continue
			}
			message := group.Message
			if message == "" && len(group.Issues) > 0 {
				message = group.Issues[0].Message
			}
			items = append(items, DiagnosticItem{Severity: group.Severity, Message: message, Files: []string{filepath.Base(result.File)}})
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		return severityRank(items[i].Severity) > severityRank(items[j].Severity)
	})
	if len(items) > 5 {
		items = items[:5]
	}
	return items
}

func reportCategories(results []Result) []string {
	seen := make(map[string]bool)
	var categories []string
	for _, result := range results {
		if result.Category != "" && !seen[result.Category] {
			seen[result.Category] = true
			categories = append(categories, result.Category)
		}
	}
	sort.Strings(categories)
	return categories
}

func reportKeywords(results []Result) []string {
	seen := make(map[string]bool)
	var keywords []string
	for _, result := range results {
		for _, group := range result.GroupedIssues {
			if !seen[group.Keyword] {
				seen[group.Keyword] = true
				keywords = append(keywords, group.Keyword)
			}
		}
	}
	sort.Strings(keywords)
	return keywords
}

/* 旧报告模板已迁移至 report_dashboard.go，以下内容仅保留在历史代码中，不参与编译。 */
/*
<html>
<head>
    <meta charset="UTF-8">
    <title>系统日志分析报告</title>
    <link href="static/bootstrap.min.css" rel="stylesheet">
    <style>
        .compact-context {
            background: #f8f9fa;
            border-radius: 4px;
            padding: 4px 6px;
            margin: 0;
            line-height: 1.2;
        }
        .compact-context code {
            display: block;
            white-space: pre-wrap;
            font-family: monospace;
            color: #d63384;
            padding: 0;
            margin: 0;
            line-height: 1.2;
        }
        .custom-table td {
            padding: 4px 8px;
            vertical-align: top;
        }
        .wide-container { max-width: 98%; margin: 0 auto; padding: 0 15px; }
        .custom-table { table-layout: fixed; word-break: break-word; }
        .custom-table th:nth-child(1) { width: 10%; }
        .custom-table th:nth-child(2) { width: 30%; }
        .custom-table th:nth-child(3) { width: 60%; }
        .accordion-flush .accordion-item { border-bottom: 1px solid #dee2e6; }
        .accordion-button:not(.collapsed) { background-color: #f8f9fa; }
        .accordion-body .table { margin-bottom: 0; }
        .truncate-info { font-size: 0.9em; color: #6c757d; }
    </style>
</head>
<body>
    <div class="wide-container mt-4">
        <h2 class="mb-4">日志分析结果</h2>
        <div class="alert alert-info">共发现 <strong>{{.Total}}</strong> 个问题</div>

        <div class="accordion" id="reportAccordion">
            {{range $fileIndex, $result := .Results}}
            <div class="card mb-4">
                <div class="card-header bg-light p-0">
                    <button class="btn btn-link text-start w-100 p-3"
                            type="button"
                            data-bs-toggle="collapse"
                            data-bs-target="#fileCollapse{{$fileIndex}}"
                            aria-expanded="false">
                        <div class="d-flex align-items-center">
                            <span class="collapse-icon me-2">▶</span>
                            <div class="flex-grow-1">
                                <span class="fw-bold">{{$result.File}}</span>
                                <span class="badge bg-secondary ms-2">{{$result.Category}}</span>
                            </div>
                            <span class="badge bg-danger rounded-pill">{{len $result.GroupedIssues}}个关键词</span>
                        </div>
                    </button>
                </div>

                <div id="fileCollapse{{$fileIndex}}" class="collapse"
                     data-bs-parent="#reportAccordion">
                    <div class="card-body p-3">
                        <div class="accordion accordion-flush" id="keywordAccordion{{$fileIndex}}">
                            {{range $keywordIndex, $group := $result.GroupedIssues}}
                            <div class="accordion-item">
                                <h3 class="accordion-header">
                                    <button class="accordion-button collapsed d-flex justify-content-between align-items-center"
                                            type="button"
                                            data-bs-toggle="collapse"
                                            data-bs-target="#keywordCollapse{{$fileIndex}}_{{$keywordIndex}}">
                                        <div class="d-flex align-items-center flex-grow-1">
                                            <span class="badge bg-warning me-2 text-nowrap">{{$group.Keyword}}</span>
                                            <span class="text-muted me-3">
                                                {{if ne $group.ShowCount $group.TotalCount}}
                                                    (共 {{$group.TotalCount}} 条，显示前 {{$group.ShowCount}} 条)
                                                {{else}}
                                                    ({{$group.ShowCount}} 条)
                                                {{end}}
                                            </span>
                                            {{if gt (len $group.Issues) 0}}
                                            <span class="text-truncate">
                                                {{(index $group.Issues 0).Message}}
                                            </span>
                                            {{end}}
                                        </div>
                                    </button>
                                </h3>
                                <div id="keywordCollapse{{$fileIndex}}_{{$keywordIndex}}"
                                     class="accordion-collapse collapse"
                                     data-bs-parent="#keywordAccordion{{$fileIndex}}">
                                    <div class="accordion-body p-0">
                                        <table class="table table-hover custom-table">
                                            <thead class="table-light">
                                                <tr>
                                                    <th>行号</th>
                                                    <th>问题描述</th>
                                                    <th>上下文</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {{range $issue := $group.Issues}}
                                                <tr>
                                                    <td>{{$issue.Line}}</td>
                                                    <td>{{$issue.Message}}</td>
                                                    <td>
                                                        <div class="compact-context text-wrap">
                                                            {{range $line := split $issue.Context "\n"}}
                                                            <code>{{$line}}</code>
                                                            {{end}}
                                                        </div>
                                                    </td>
                                                </tr>
                                                {{end}}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                            {{end}}
                        </div>
                    </div>
                </div>
            </div>
            {{end}}
        </div>
    </div>
    <script src="static/bootstrap.bundle.min.js"></script>
</body>
</html>`
*/
