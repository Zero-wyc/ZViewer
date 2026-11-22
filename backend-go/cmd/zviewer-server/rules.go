package main

// 规则包命令行：给单文件包与 Docker 用。
//
// 网页端「管理 → 全网搜片」是主路径；这条命令是无人值守/脚本化部署的兜底：
//
//	docker cp crawler-rules.json zviewer:/app/
//	docker exec zviewer ./zviewer-backend --import-rules /app/crawler-rules.json
//
// 与 HTTP 导入共用 crawler.ImportBundleWithOptions，报告字段完全一致——两条路
// 不会出现「同一份包，网页说成功、命令行说失败」。
//
// 这个入口不连数据库、不开端口：规则只是 <root>/data/rules 下的 JSON 文件。

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"zviewer/backend/internal/config"
	"zviewer/backend/internal/crawler"
)

// rulesCLIMaxBytes 与网页端保持同一个上限，避免命令行绕过限制塞进超大文件。
const rulesCLIMaxBytes = 8 << 20

// runRulesCLI 是 `--import-rules` / `--export-rules` 的唯一实现，返回进程退出码。
func runRulesCLI(args []string, cfg *config.Config, stdout, stderr io.Writer) int {
	if root, ok := flagValue(args, "--root"); ok {
		if err := os.Setenv("CRAWLER_ROOT", root); err != nil {
			fmt.Fprintf(stderr, "  [错误] 无法设置规则目录: %v\n", err)
			return 1
		}
	}
	root, err := crawler.UseDefaultRoot(cfg.ConfigDir)
	if err != nil {
		fmt.Fprintf(stderr, "  [错误] %v\n", err)
		return 1
	}
	store, err := crawler.NewRuleStore(filepath.Join(root, "data", "rules"))
	if err != nil {
		fmt.Fprintf(stderr, "  [错误] 规则目录不可用: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "  规则目录: %s\n", root)

	if path, ok := flagValue(args, "--export-rules"); ok {
		return exportRulesCLI(store, path, stdout, stderr)
	}
	path, ok := flagValue(args, "--import-rules")
	if !ok {
		fmt.Fprintln(stderr, "用法: zviewer-backend --import-rules <文件> [--mode merge|replace] [--dry-run]")
		fmt.Fprintln(stderr, "      zviewer-backend --export-rules <文件>")
		return 1
	}
	return importRulesCLI(store, root, path, args, stdout, stderr)
}

func importRulesCLI(store *crawler.RuleStore, root, path string, args []string, stdout, stderr io.Writer) int {
	info, err := os.Stat(path)
	if err != nil {
		fmt.Fprintf(stderr, "  [错误] 无法读取文件: %v\n", err)
		return 1
	}
	if info.Size() > rulesCLIMaxBytes {
		fmt.Fprintf(stderr, "  [错误] 规则文件不能超过 %d MB\n", rulesCLIMaxBytes>>20)
		return 1
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(stderr, "  [错误] 无法读取文件: %v\n", err)
		return 1
	}
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		fmt.Fprintf(stderr, "  [错误] 规则文件不是有效 JSON: %v\n", err)
		return 1
	}

	mode, _ := flagValue(args, "--mode")
	opts := crawler.ImportOptions{
		Mode:          mode,
		DryRun:        hasFlag(args, "--dry-run"),
		ClearAccounts: hasFlag(args, "--clear-accounts"),
		ClearRooms:    hasFlag(args, "--clear-rooms"),
	}
	// 账号库读得到才做「缺账号」检查：读不到就别给所有规则扣一顶帽子。
	if accounts, accErr := crawler.NewAccountStore(filepath.Join(root, "data", "accounts.json")); accErr == nil {
		opts.HasAccount = func(accountID string) bool { return accounts.Get(accountID) != nil }
	}

	report, err := store.ImportBundleWithOptions(payload, opts)
	if err != nil {
		fmt.Fprintf(stderr, "  [错误] %v\n", err)
		return 1
	}

	prefix := ""
	if opts.DryRun {
		prefix = "（预检，未写入）"
	}
	fmt.Fprintf(stdout, "  导入%s 模式=%v 共 %v 条：新增 %v，更新 %v，失败 %v\n",
		prefix, report["mode"], report["total"], report["imported"], report["updated"], report["failed"])
	printImportDetails(stdout, report)

	if success, _ := report["success"].(bool); !success {
		return 1
	}
	return 0
}

// printImportDetails 把每条规则的落点与换机提示打出来。
// 网页端是表格，命令行是缩进列表——信息同一份，不各写一套判断。
func printImportDetails(stdout io.Writer, report map[string]any) {
	if backup, _ := report["backupFile"].(string); backup != "" {
		fmt.Fprintf(stdout, "    替换前已备份原规则到 %s\n", backup)
	}
	if warnings, ok := report["warnings"].([]string); ok {
		for _, warning := range warnings {
			fmt.Fprintf(stdout, "    ! %s\n", warning)
		}
	}
	items, _ := report["items"].([]map[string]any)
	for _, item := range items {
		action, _ := item["action"].(string)
		name, _ := item["name"].(string)
		ruleID, _ := item["ruleId"].(string)
		switch action {
		case "create", "update":
			label := "新增"
			if action == "update" {
				label = "更新"
			}
			// 预检时还没有落盘 id，别打出一个空箭头（「→ 」看着像坏了）。
			if ruleID == "" {
				fmt.Fprintf(stdout, "    [%s] %s\n", label, name)
			} else {
				fmt.Fprintf(stdout, "    [%s] %s → %s\n", label, name, ruleID)
			}
		case "failed":
			fmt.Fprintf(stdout, "    [失败] %s：%v\n", name, item["error"])
		}
		for _, note := range stringList(item["notes"]) {
			fmt.Fprintf(stdout, "        - %s\n", note)
		}
		for _, warning := range stringList(item["warnings"]) {
			fmt.Fprintf(stdout, "        ! %s\n", warning)
		}
	}
}

func exportRulesCLI(store *crawler.RuleStore, path string, stdout, stderr io.Writer) int {
	bundle := store.ExportBundle(nil)
	raw, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		fmt.Fprintf(stderr, "  [错误] 序列化规则失败: %v\n", err)
		return 1
	}
	raw = append(raw, '\n')
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		fmt.Fprintf(stderr, "  [错误] 无法写入文件: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "  已导出 %v 条规则到 %s\n", bundle["count"], path)
	return 0
}

// stringList 把报告里可能是 []string 也可能缺省的值统一成切片。
func stringList(value any) []string {
	list, ok := value.([]string)
	if !ok {
		return nil
	}
	return list
}
