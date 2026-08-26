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
	for _, expected := range []string{"分析规则编辑器", "保存草稿", "导出我的规则", "application/json"} {
		if !strings.Contains(page, expected) {
			t.Fatalf("report.html 缺少 %q", expected)
		}
	}
}

func TestEditorIncludesReadOnlyOfficialRulesAndTemplates(t *testing.T) {
	for _, pagePath := range []string{"editor.html", "renderer/index.html"} {
		content, err := os.ReadFile(pagePath)
		if err != nil {
			t.Fatal(err)
		}
		page := string(content)
		for _, expected := range []string{
			"id=\"officialList\"",
			"id=\"officialResultSummary\"",
			"id=\"clearOfficialFilters\"",
			"id=\"officialCategoryList\"",
			"id=\"addOfficialCategory\"",
			"id=\"userCategoryList\"",
			"id=\"addUserCategory\"",
			"id=\"officialCategories\"",
			"id=\"template\"",
			"linux-error",
			"hostInfo",
			"主规则由维护者发布",
			"id=\"editorTitle\"",
			"id=\"emptyFromOfficial\"",
			"data-reference",
			"data-detail",
			"data-file-toggle",
			"data-category-filter",
			"data-category-add",
			"data-user-category-filter",
			"data-user-category-add",
			"function openCategoryRule",
			"id=\"categoryDialog\"",
			"id=\"newCategoryName\"",
			"function saveCategory",
			"请先创建分类，再在分类下创建规则",
			"categories:[]",
			"official-details",
			"按文字匹配",
			"按规则表达式匹配",
			"找到 ${matched} 条规则，分布在 ${visibleFiles} 个文件中",
			"id=\"saveBottom\"",
			"submitSelectedRules',{user:state.user}",
			"localIds",
			"submissionAvailable",
		} {
			if !strings.Contains(page, expected) {
				t.Fatalf("editor.html 缺少 %q", expected)
			}
		}
		if strings.Contains(page, "event.ctrlKey") {
			t.Fatal("维护者入口不应再依赖 Ctrl+Shift+Alt+R 快捷键")
		}
		for _, forbidden := range []string{
			"maintainerUnlockDialog",
			"maintainerSetupDialog",
			"maintainerReleaseDialog",
			"setMaintainerToken",
			"submitMaintainerRules",
			"GitHub Fine-grained Token",
		} {
			if strings.Contains(page, forbidden) {
				t.Fatalf("普通用户页面不应包含维护者流程或 Token：%q", forbidden)
			}
		}
	}
}
