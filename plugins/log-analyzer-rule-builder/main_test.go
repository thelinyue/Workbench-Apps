package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseOptionsRequiresOutput(t *testing.T) {
	_, err := parseOptions([]string{"--case", "demo", "--input", "sample.tgz"})
	if err == nil || !strings.Contains(err.Error(), "--output") {
		t.Fatalf("缺少输出目录时应返回中文错误，实际为 %v", err)
	}
}

func TestRunWritesSelfContainedReport(t *testing.T) {
	output := t.TempDir()
	if err := run([]string{"--case", "demo", "--input", "sample.tgz", "--output", output}); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(output, "report.html"))
	if err != nil {
		t.Fatal(err)
	}
	page := string(content)
    for _, expected := range []string{"分析规则编辑器", "保存我的规则", "导出我的规则", "application/json"} {
		if !strings.Contains(page, expected) {
			t.Fatalf("report.html 缺少 %q", expected)
		}
	}
}

func TestEditorIncludesReadOnlyOfficialRulesAndTemplates(t *testing.T) {
	content, err := os.ReadFile("editor.html")
	if err != nil {
		t.Fatal(err)
	}
	page := string(content)
	for _, expected := range []string{
		"id=\"officialList\"",
		"id=\"officialCategories\"",
		"id=\"template\"",
		"linux-error",
		"hostInfo",
		"主规则由维护者发布",
		"event.ctrlKey",
		"id=\"maintainerUnlockDialog\"",
		"id=\"maintainerSetupDialog\"",
		"getMaintainerSetupState",
		"configureMaintainer",
		"id=\"maintainerReleaseDialog\"",
		"setMaintainerToken",
		"submitMaintainerRules",
		"maintainerSetupDialog').classList.add('hidden')",
	} {
		if !strings.Contains(page, expected) {
			t.Fatalf("editor.html 缺少 %q", expected)
		}
	}
}
