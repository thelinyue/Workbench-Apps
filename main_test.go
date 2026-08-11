package main

import (
	"bytes"
	"html/template"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseSysInfo(t *testing.T) {
	content := []byte(`{
		"deviceName": "UGREEN DX4600",
		"sn": "SN-001",
		"systemVersion": "1.2.3",
        "system": {"version": "5.15", "arch": "x86_64"},
        "disk_info": [{
            "name": "sda",
            "model": "Example SSD",
            "serial": "DISK-001",
            "capacity": "1TB",
            "smart": [{"id": 5, "name": "Reallocated", "raw": "0"}, {"id": 197, "name": "Pending", "raw": "2"}]
        }]
    }`)

	summary := parseSysInfo(content)
	if summary == nil || summary.Model != "UGREEN DX4600" || summary.SerialNumber != "SN-001" || summary.Firmware != "1.2.3" {
		t.Fatalf("设备摘要解析失败: %#v", summary)
	}
	if len(summary.Disks) != 1 || summary.Disks[0].Name != "sda" || len(summary.Disks[0].Smart) != 2 {
		t.Fatalf("硬盘或 SMART 解析失败: %#v", summary.Disks)
	}
	if summary.Disks[0].Smart[0].Status != "正常" || summary.Disks[0].Smart[1].Status != "风险" {
		t.Fatalf("SMART 状态判断失败: %#v", summary.Disks[0].Smart)
	}
}

func TestParseSysInfoDeviceSmartInfo(t *testing.T) {
	content := []byte(`{"deviceName":"DX4600","disk":{"devices":[{"disk_info":{"name":"sda","label":"DataPool","slot":"ata1","model":"HDD"},"smart_info":{"report":[{"id":5,"name":"重映射扇区","raw":"0"},{"id":197,"name":"待处理坏扇区","raw":"2"},{"id":198,"name":"不可修复扇区","raw":"0"}]}}]}}`)
	summary := parseSysInfo(content)
	if summary == nil || len(summary.Disks) != 1 || len(summary.Disks[0].Smart) != 3 {
		t.Fatalf("嵌套 disk_info/smart_info 解析失败: %#v", summary)
	}
	if summary.Disks[0].Label != "DataPool" || summary.Disks[0].Smart[1].ID != 197 || summary.Disks[0].Smart[1].Raw != "2" {
		t.Fatalf("SMART 具体值解析错误: %#v", summary.Disks[0])
	}
}

func TestDiagnosticSummaryIncludesDiskLabelAndSmartRaw(t *testing.T) {
	sysInfo := &SysInfoSummary{Disks: []DiskSummary{{Label: "DataPool", Smart: []SmartAttribute{{ID: 5, Name: "重映射扇区", Raw: "0"}, {ID: 197, Name: "待处理坏扇区", Raw: "2"}}}}}
	summary := buildDiagnosticSummary(nil, sysInfo)
	if !strings.Contains(summary, "DataPool") || !strings.Contains(summary, "ID 197") || !strings.Contains(summary, "RAW=2") {
		t.Fatalf("诊断摘要未包含 SMART 风险详情: %s", summary)
	}
}

func TestFocusSmartAttributes(t *testing.T) {
	attributes := focusSmartAttributes([]SmartAttribute{{ID: 1}, {ID: 5}, {ID: 197}, {ID: 198}, {ID: 200}})
	if len(attributes) != 3 || attributes[0].ID != 5 || attributes[1].ID != 197 || attributes[2].ID != 198 {
		t.Fatalf("SMART 重点属性筛选错误: %#v", attributes)
	}
}

func TestDmiDecodeRulesOnlyKeepMemoryFields(t *testing.T) {
	cfg := loadConfig()
	fileConfig := matchFileConfig("syslog", cfg)
	if fileConfig == nil {
		t.Fatal("未找到 syslog 规则")
	}
	foundTrigger := false
	for _, keyword := range fileConfig.Keywords {
		if keyword.Term == "dmidecode 3.4" && keyword.Result == "内存信息" {
			foundTrigger = true
		}
		if keyword.Result == "内存大小" || keyword.Result == "内存品牌" || keyword.Result == "内存型号" {
			t.Fatalf("dmidecode 字段不应继续作为普通日志规则: %s", keyword.Result)
		}
	}
	if !foundTrigger {
		t.Fatal("缺少 dmidecode 内存结构化触发规则")
	}
}

func TestParseDmiMemory(t *testing.T) {
	content := []byte(`# dmidecode 3.4
Memory Device
    Size: 8 GB
    Manufacturer: Kingston
    Part Number: CBD26D4S9S8K1C-8
    Serial Number: ignored

Memory Device
    Size: No Module Installed
    Manufacturer: Empty
`)
	memory := parseDmiMemory(content)
	if len(memory) != 1 || memory[0].Size != "8 GB" || memory[0].Manufacturer != "Kingston" || memory[0].Model != "CBD26D4S9S8K1C-8" {
		t.Fatalf("dmidecode 内存解析错误: %#v", memory)
	}
}

func TestDiagnosticSummaryIncludesSataFault(t *testing.T) {
	results := []Result{{GroupedIssues: []GroupedIssue{{Keyword: "ata", Message: "SATA接触不良或硬盘故障", Severity: SeverityCritical}}}}
	summary := buildDiagnosticSummary(results, nil)
	if !strings.Contains(summary, "SATA 接触不良或硬盘故障风险") {
		t.Fatalf("SATA 故障未进入快速诊断结论: %s", summary)
	}
}

func TestProcessFileMergesSameKeywordAndDeduplicatesLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sample.log")
	if err := os.WriteFile(path, []byte("ERR\nnormal\nERR\n"), 0644); err != nil {
		t.Fatal(err)
	}
	config := &FileConfig{Name: "sample.log", Category: "测试", Keywords: []Keyword{{Term: "ERR", Result: "错误", Severity: SeverityCritical, ContextLines: 0, ContextDirection: "down", SearchDirection: "down", Order: 0}}}
	result := processFile(path, config)
	if len(result.GroupedIssues) != 1 {
		t.Fatalf("同关键词未合并: %#v", result.GroupedIssues)
	}
	group := result.GroupedIssues[0]
	if group.TotalCount != 2 || group.FirstLine != 1 || group.LastLine != 3 || group.Severity != SeverityCritical {
		t.Fatalf("问题统计错误: %#v", group)
	}
}

func TestApplyMaxEntriesKeepsLatestMatches(t *testing.T) {
	issues := make([]Issue, 0, 60)
	for line := 1; line <= 60; line++ {
		issues = append(issues, Issue{Line: line})
	}
	limited := applyMaxEntries([]Result{{GroupedIssues: []GroupedIssue{{Issues: issues}}}}, 50)
	group := limited[0].GroupedIssues[0]
	if group.TotalCount != 60 || group.ShowCount != 50 || group.Issues[0].Line != 11 || group.Issues[49].Line != 60 {
		t.Fatalf("未保留最新 50 条命中: total=%d show=%d first=%d last=%d", group.TotalCount, group.ShowCount, group.Issues[0].Line, group.Issues[49].Line)
	}
}

func TestResolveReportPathUsesLegacyDefault(t *testing.T) {
	finalDir := filepath.Join(t.TempDir(), "extract")
	path, err := resolveReportPath(finalDir, "")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(finalDir, "report", "report.html"); path != want {
		t.Fatalf("默认报告路径错误: got=%s want=%s", path, want)
	}
}

func TestResolveReportPathUsesSpecifiedDirectory(t *testing.T) {
	finalDir := filepath.Join(t.TempDir(), "extract")
	outputDir := filepath.Join(t.TempDir(), "case-report")
	path, err := resolveReportPath(finalDir, outputDir)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(outputDir, "report.html"); path != want {
		t.Fatalf("指定报告路径错误: got=%s want=%s", path, want)
	}
}

func TestResolveReportPathRejectsOptionLikeDirectory(t *testing.T) {
	if _, err := resolveReportPath(t.TempDir(), "-invalid"); err == nil {
		t.Fatal("应拒绝以短横线开头的报告输出目录")
	}
}

func TestDashboardTemplateEscapesLogContent(t *testing.T) {
	data := ReportData{
		Title:   "测试报告",
		Results: []Result{{File: "x.log", Category: "测试", GroupedIssues: []GroupedIssue{{Keyword: "x", Message: "描述", Severity: SeverityWarning, TotalCount: 1, ShowCount: 1, Issues: []Issue{{Line: 1, Context: "<script>alert(1)</script>", ContextLines: []ContextLine{{Number: 1, Text: "<script>alert(1)</script>", Hit: true}}}}}}}},
	}
	tmpl, err := template.New("report").Funcs(template.FuncMap{"split": strings.Split, "smartFocus": focusSmartAttributes, "smartRiskReminder": smartRiskReminder, "smartHasRisk": smartHasRisk}).Parse(dashboardReportTemplate)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := tmpl.Execute(&output, data); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "<script>alert(1)</script>") {
		t.Fatal("日志内容未进行 HTML 转义")
	}
}

func TestExtractBuildVersionsKeepsLatestTimestamp(t *testing.T) {
	result := Result{File: "/logs/app_serv.log", Category: "应用中心", GroupedIssues: []GroupedIssue{{Keyword: "Build version", Message: "构建版本", Issues: []Issue{
		{Line: 1, ContextLines: []ContextLine{{Number: 1, Text: "2026-01-01 10:00:00 Build version 1.0.0", Hit: true}}},
		{Line: 2, ContextLines: []ContextLine{{Number: 2, Text: "2026-02-01 10:00:00 Build version 2.0.0", Hit: true}}},
	}}}}
	versions := extractBuildVersions([]Result{result})
	if len(versions) != 1 || versions[0].Version != "2.0.0" || versions[0].Timestamp != "2026-02-01 10:00:00" {
		t.Fatalf("未保留最新构建版本: %#v", versions)
	}
}

func TestExtractBuildVersionsPrefersCurrentSlog(t *testing.T) {
	makeResult := func(file, version string) Result {
		return Result{File: file, Category: "应用", GroupedIssues: []GroupedIssue{{Keyword: "Build version", Message: "构建版本", Issues: []Issue{{Line: 1, ContextLines: []ContextLine{{Number: 1, Text: "Build version " + version, Hit: true}}}}}}}
	}
	versions := extractBuildVersions([]Result{
		makeResult("/logs/app_serv.slog.1", "1.0.0"),
		makeResult("/logs/app_serv.slog", "2.0.0"),
	})
	if len(versions) != 1 || versions[0].Version != "2.0.0" || versions[0].Application != "app_serv" {
		t.Fatalf("未优先使用当前 slog: %#v", versions)
	}
}
