package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// SysInfoSummary 是 sysinfo.json 的结构化摘要，解析失败时不影响普通日志分析。
type SysInfoSummary struct {
	Model        string
	SerialNumber string
	Firmware     string
	Platform     string
	System       []KeyValue
	Networks     []NetworkInterfaceCard
	Disks        []DiskSummary
	RawJSON      string
}

type KeyValue struct {
	Key   string
	Value string
}

// MemoryModule 是 dmidecode 中一条已安装内存条的可读摘要。
type MemoryModule struct {
	Size         string
	Manufacturer string
	Model        string
}

// DiskSummary 是 sysinfo.json 中一块磁盘的工程诊断摘要，字段缺失时保留为空。
type DiskSummary struct {
	Name          string
	DeviceName    string
	Label         string
	UsedFor       string
	Slot          string
	Model         string
	Serial        string
	Brand         string
	InterfaceType string
	Capacity      string
	Temperature   string
	PowerOnHours  string
	Health        string
	Smart         []SmartAttribute
}

// SmartAttribute 是一条 SMART 属性，同时保留原始值和适合诊断的状态。
type SmartAttribute struct {
	ID        int
	Name      string
	Value     string
	Worst     string
	Threshold string
	Raw       string
	Status    string
}

// focusSmartAttributes 只保留工程师首要关注的三项 SMART 属性，避免健康信息卡片过度展开。
func focusSmartAttributes(attributes []SmartAttribute) []SmartAttribute {
	focused := make([]SmartAttribute, 0, 3)
	for _, attribute := range attributes {
		if attribute.ID == 5 || attribute.ID == 197 || attribute.ID == 198 {
			focused = append(focused, attribute)
		}
	}
	return focused
}

// smartRiskReminder 将关键 SMART 项的风险提示放在硬盘卡片内，避免工程师只看到状态颜色而忽略处理建议。
func smartRiskReminder(attributes []SmartAttribute) string {
	var risks []string
	for _, attribute := range focusSmartAttributes(attributes) {
		if attribute.Status == "风险" {
			risks = append(risks, fmt.Sprintf("%s（ID %d，RAW=%s）", attribute.Name, attribute.ID, attribute.Raw))
		}
	}
	if len(risks) == 0 {
		return ""
	}
	return "注意：" + strings.Join(risks, "、") + "，建议尽快检查硬盘健康状态。"
}

func smartHasRisk(attributes []SmartAttribute) bool {
	for _, attribute := range focusSmartAttributes(attributes) {
		if attribute.Status == "风险" {
			return true
		}
	}
	return false
}

// parseDmiMemory 只解析 Memory Device 段落中的容量、品牌和型号，避免把 DMI 的其他字段带入报告。
func parseDmiMemory(content []byte) []MemoryModule {
	lines := strings.Split(string(content), "\n")
	var modules []MemoryModule
	var current *MemoryModule
	inDevice := false
	flush := func() {
		if current != nil && current.Size != "" {
			modules = append(modules, *current)
		}
		current = nil
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.Contains(trimmed, "Memory Device") {
			flush()
			current = &MemoryModule{}
			inDevice = true
			continue
		}
		if !inDevice {
			continue
		}
		if trimmed == "" {
			flush()
			inDevice = false
			continue
		}
		if value := dmiFieldValue(trimmed, "Size:"); value != "" && validMemorySize(value) {
			current.Size = value
		}
		if value := dmiFieldValue(trimmed, "Manufacturer:"); value != "" {
			current.Manufacturer = value
		}
		if value := dmiFieldValue(trimmed, "Part Number:"); value != "" {
			current.Model = value
		}
	}
	flush()

	seen := make(map[string]bool)
	result := make([]MemoryModule, 0, len(modules))
	for _, module := range modules {
		key := module.Size + "\x00" + module.Manufacturer + "\x00" + module.Model
		if seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, module)
	}
	return result
}

func dmiFieldValue(line, field string) string {
	index := strings.Index(line, field)
	if index < 0 {
		return ""
	}
	return strings.TrimSpace(line[index+len(field):])
}

func validMemorySize(value string) bool {
	parts := strings.Fields(value)
	if len(parts) < 2 || (strings.ToUpper(parts[1]) != "GB" && strings.ToUpper(parts[1]) != "MB") {
		return false
	}
	_, err := strconv.ParseFloat(parts[0], 64)
	return err == nil
}

func parseSysInfo(content []byte) *SysInfoSummary {
	var root interface{}
	if err := json.Unmarshal(content, &root); err != nil {
		return nil
	}
	raw, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return nil
	}

	summary := &SysInfoSummary{
		Model:        firstString(root, "deviceName"),
		SerialNumber: firstString(root, "sn", "serial", "serial_number", "serialNumber"),
		Firmware:     firstString(root, "systemVersion"),
		Platform:     firstString(root, "platform", "architecture", "arch"),
		RawJSON:      string(raw),
	}
	summary.Networks = parseSysInfoNetworks(root)
	if system := firstValue(root, "system", "system_info", "os"); system != nil {
		summary.System = flattenKeyValues(system, "", 20)
	}

	for _, value := range findValues(root, "disk_info", "disks", "disk") {
		summary.Disks = append(summary.Disks, diskSummaries(value)...)
	}
	if deviceDisks := diskSummariesFromDevices(root); len(deviceDisks) > 0 {
		summary.Disks = deviceDisks
	}
	if len(summary.Disks) == 0 {
		for _, value := range findMapsWithSmart(root) {
			if disk := diskSummary(value); disk != nil {
				summary.Disks = append(summary.Disks, *disk)
			}
		}
	}
	summary.Disks = deduplicateDisks(summary.Disks)

	if summary.Model == "" && summary.SerialNumber == "" && summary.Firmware == "" && summary.Platform == "" && len(summary.System) == 0 && len(summary.Networks) == 0 && len(summary.Disks) == 0 {
		return nil
	}
	return summary
}

// parseSysInfoNetworks 将 sysinfo.json 中的 network.interface 转换为报告使用的统一网卡模型。
// sysinfo 只提供快照状态，因此未连接接口显示为“未连接”，不直接升级为诊断风险。
func parseSysInfoNetworks(root interface{}) []NetworkInterfaceCard {
	network := firstValue(root, "network", "network_info")
	if network == nil {
		return nil
	}
	var interfaces []NetworkInterfaceCard
	for _, value := range findValues(network, "interface", "interfaces") {
		items, ok := value.([]interface{})
		if !ok {
			items = []interface{}{value}
		}
		for _, item := range items {
			object, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			runningValue := firstValue(object, "is_running", "running", "up")
			status := "未知"
			state := "未知"
			carrier := ""
			if runningValue != nil {
				status = "未连接"
				state = "DOWN"
				carrier = "NO-CARRIER"
				if boolValue(runningValue) {
					status = "正常"
					state = "UP"
					carrier = "CARRIER"
				}
			}
			card := NetworkInterfaceCard{
				Name:    firstString(object, "name"),
				State:   state,
				Carrier: carrier,
				MAC:     firstString(object, "mac", "hardware_address"),
				IPv4:    stringValues(firstValue(object, "ipv4")),
				IPv6:    stringValues(firstValue(object, "ipv6")),
				MTU:     firstString(object, "mtu"),
				Status:  status,
			}
			if card.Name == "" {
				card.Name = firstString(object, "interface")
			}
			interfaces = append(interfaces, card)
		}
	}
	return interfaces
}

func diskSummariesFromDevices(value interface{}) []DiskSummary {
	var disks []DiskSummary
	switch typed := value.(type) {
	case []interface{}:
		for _, item := range typed {
			disks = append(disks, diskSummariesFromDevices(item)...)
		}
	case map[string]interface{}:
		if diskInfo, ok := typed["disk_info"]; ok {
			if disk := diskSummary(diskInfo); disk != nil {
				if smartInfo, ok := typed["smart_info"]; ok {
					// smart_info.report 在不同版本中可能是数组或嵌套对象，统一从 report 节点提取。
					for _, report := range findValues(smartInfo, "report") {
						disk.Smart = append(disk.Smart, smartAttributes(report)...)
					}
					if len(disk.Smart) == 0 {
						disk.Smart = smartAttributes(smartInfo)
					}
				}
				disks = append(disks, *disk)
			}
		}
		for _, child := range typed {
			disks = append(disks, diskSummariesFromDevices(child)...)
		}
	}
	return disks
}

func diskSummaries(value interface{}) []DiskSummary {
	var disks []DiskSummary
	switch typed := value.(type) {
	case []interface{}:
		for _, item := range typed {
			if disk := diskSummary(item); disk != nil {
				disks = append(disks, *disk)
			}
		}
	case map[string]interface{}:
		if disk := diskSummary(typed); disk != nil {
			disks = append(disks, *disk)
		}
		for _, key := range []string{"items", "list", "devices", "disks"} {
			if nested, ok := typed[key]; ok {
				disks = append(disks, diskSummaries(nested)...)
			}
		}
	}
	return disks
}

func diskSummary(value interface{}) *DiskSummary {
	object, ok := value.(map[string]interface{})
	if !ok {
		return nil
	}
	disk := &DiskSummary{
		Name:          firstString(object, "name"),
		DeviceName:    firstString(object, "dev_name", "device_name", "device_path"),
		Label:         firstString(object, "label"),
		UsedFor:       firstString(object, "used_for", "usage"),
		Slot:          firstString(object, "slot"),
		Model:         firstString(object, "model"),
		Serial:        firstString(object, "serial"),
		Brand:         firstString(object, "brand", "manufacturer"),
		InterfaceType: firstString(object, "interface_type", "interface"),
		Capacity:      formatCapacity(firstValue(object, "size", "capacity")),
		Temperature:   firstString(object, "temperature", "temp"),
		PowerOnHours:  formatPowerOnHours(firstValue(object, "power_on_hours", "powerOnHours")),
		Health:        normalizeDiskHealth(firstString(object, "health", "status")),
	}
	for _, value := range findValues(object, "smart", "smart_attributes", "attributes") {
		disk.Smart = append(disk.Smart, smartAttributes(value)...)
	}
	if disk.Name == "" && disk.DeviceName == "" && disk.Label == "" && disk.UsedFor == "" && disk.Slot == "" && disk.Model == "" && disk.Serial == "" && len(disk.Smart) == 0 {
		return nil
	}
	return disk
}

func smartAttributes(value interface{}) []SmartAttribute {
	var attributes []SmartAttribute
	switch typed := value.(type) {
	case []interface{}:
		for _, item := range typed {
			if attribute := smartAttribute(item); attribute != nil {
				attributes = append(attributes, *attribute)
			}
		}
	case map[string]interface{}:
		if attribute := smartAttribute(typed); attribute != nil {
			attributes = append(attributes, *attribute)
		}
	}
	return attributes
}

func smartAttribute(value interface{}) *SmartAttribute {
	object, ok := value.(map[string]interface{})
	if !ok {
		return nil
	}
	idValue := firstValue(object, "id", "ID", "attribute_id")
	id, _ := strconv.Atoi(asString(idValue))
	raw := firstString(object, "raw_string", "raw", "raw_value", "rawValue", "raw_val")
	status := smartStatus(id, raw)
	if id != 5 && id != 197 && id != 198 {
		status = smartSourceStatus(firstValue(object, "status"), status)
	}
	attribute := &SmartAttribute{
		ID:        id,
		Name:      firstString(object, "name", "attribute", "label"),
		Value:     firstString(object, "value", "current"),
		Worst:     firstString(object, "worst"),
		Threshold: firstString(object, "threshold", "thresh"),
		Raw:       raw,
		Status:    status,
	}
	if attribute.ID == 0 && attribute.Name == "" && attribute.Raw == "" {
		return nil
	}
	return attribute
}

func smartStatus(id int, raw string) string {
	if id != 5 && id != 197 && id != 198 {
		return "普通"
	}
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return "未知"
	}
	if value == 0 {
		return "正常"
	}
	return "风险"
}

func smartSourceStatus(value interface{}, fallback string) string {
	if value == nil {
		return fallback
	}
	switch strings.ToLower(strings.TrimSpace(asString(value))) {
	case "1", "ok", "normal", "正常":
		return "正常"
	case "0", "unknown", "未知":
		return "未知"
	case "risk", "warning", "failed", "风险", "警告":
		return "风险"
	default:
		return fallback
	}
}

func boolValue(value interface{}) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true") || strings.TrimSpace(typed) == "1"
	default:
		return asString(value) == "1"
	}
}

func stringValues(value interface{}) []string {
	var values []string
	switch typed := value.(type) {
	case []interface{}:
		for _, item := range typed {
			if text := strings.TrimSpace(asString(item)); text != "" {
				values = append(values, text)
			}
		}
	case string:
		for _, item := range strings.FieldsFunc(typed, func(r rune) bool { return r == ',' || r == ';' || r == '\n' }) {
			if text := strings.TrimSpace(item); text != "" {
				values = append(values, text)
			}
		}
	default:
		if text := strings.TrimSpace(asString(value)); text != "" {
			values = append(values, text)
		}
	}
	return values
}

func formatCapacity(value interface{}) string {
	raw := strings.TrimSpace(asString(value))
	if raw == "" {
		return ""
	}
	number, err := strconv.ParseFloat(raw, 64)
	if err != nil || number <= 0 {
		return raw
	}
	units := []string{"B", "KB", "MB", "GB", "TB", "PB"}
	unitIndex := 0
	for number >= 1024 && unitIndex < len(units)-1 {
		number /= 1024
		unitIndex++
	}
	if unitIndex == 0 {
		return fmt.Sprintf("%.0f %s", number, units[unitIndex])
	}
	return fmt.Sprintf("%.2f %s", number, units[unitIndex])
}

func formatPowerOnHours(value interface{}) string {
	raw := strings.TrimSpace(asString(value))
	if raw == "" {
		return ""
	}
	hours, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || hours < 0 {
		return raw
	}
	return fmt.Sprintf("%d 天 %d 小时", hours/24, hours%24)
}

func normalizeDiskHealth(value string) string {
	switch strings.TrimSpace(value) {
	case "1":
		return "正常"
	case "0":
		return "未知"
	default:
		return value
	}
}

func firstString(value interface{}, keys ...string) string {
	return asString(firstValue(value, keys...))
}

func firstValue(value interface{}, keys ...string) interface{} {
	if object, ok := value.(map[string]interface{}); ok {
		for _, wanted := range keys {
			for key, child := range object {
				if strings.EqualFold(key, wanted) {
					return child
				}
			}
		}
	}
	var found interface{}
	walkJSON(value, func(key string, child interface{}) bool {
		for _, wanted := range keys {
			if strings.EqualFold(key, wanted) {
				found = child
				return false
			}
		}
		return found == nil
	})
	return found
}

func findValues(value interface{}, keys ...string) []interface{} {
	var values []interface{}
	walkJSON(value, func(key string, child interface{}) bool {
		for _, wanted := range keys {
			if strings.EqualFold(key, wanted) {
				values = append(values, child)
				break
			}
		}
		return true
	})
	return values
}

func findMapsWithSmart(value interface{}) []map[string]interface{} {
	var objects []map[string]interface{}
	walkJSON(value, func(key string, child interface{}) bool {
		object, ok := child.(map[string]interface{})
		if ok && (key == "smart" || key == "smart_attributes" || key == "attributes") {
			objects = append(objects, object)
		}
		return true
	})
	return objects
}

func walkJSON(value interface{}, visit func(string, interface{}) bool) bool {
	switch typed := value.(type) {
	case map[string]interface{}:
		for key, child := range typed {
			if !visit(key, child) {
				return false
			}
			if !walkJSON(child, visit) {
				return false
			}
		}
	case []interface{}:
		for _, child := range typed {
			if !walkJSON(child, visit) {
				return false
			}
		}
	}
	return true
}

func flattenKeyValues(value interface{}, prefix string, limit int) []KeyValue {
	var values []KeyValue
	var walk func(interface{}, string)
	walk = func(current interface{}, path string) {
		if len(values) >= limit {
			return
		}
		switch typed := current.(type) {
		case map[string]interface{}:
			keys := make([]string, 0, len(typed))
			for key := range typed {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				childPath := key
				if path != "" {
					childPath = path + "." + key
				}
				walk(typed[key], childPath)
			}
		case []interface{}:
			values = append(values, KeyValue{Key: path, Value: fmt.Sprintf("[%d 项]", len(typed))})
		default:
			text := asString(current)
			if text != "" {
				values = append(values, KeyValue{Key: path, Value: text})
			}
		}
	}
	walk(value, prefix)
	return values
}

func asString(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(typed)
	default:
		return fmt.Sprint(typed)
	}
}

func deduplicateDisks(disks []DiskSummary) []DiskSummary {
	seen := make(map[string]bool)
	result := make([]DiskSummary, 0, len(disks))
	for _, disk := range disks {
		key := disk.Name + "\x00" + disk.Label + "\x00" + disk.Slot + "\x00" + disk.Model + "\x00" + disk.Serial
		if key == "\x00\x00\x00\x00\x00" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, disk)
	}
	return result
}
