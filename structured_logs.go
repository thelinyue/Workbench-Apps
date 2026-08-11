package main

import (
	"bytes"
	"regexp"
	"strings"
)

type BlockDeviceCard struct {
	Name       string
	Size       string
	Type       string
	FileSystem string
	MountPoint string
	ReadOnly   string
	Removable  string
}

type NetworkInterfaceCard struct {
	Name    string
	State   string
	Carrier string
	MAC     string
	IPv4    []string
	IPv6    []string
	MTU     string
	Speed   string
	Status  string
}

func parseLsblk(content []byte) []BlockDeviceCard {
	lines := bytes.Split(content, []byte{'\n'})
	headerIndex := -1
	var headers []string
	for i, line := range lines {
		fields := strings.Fields(string(line))
		if len(fields) > 1 && strings.EqualFold(fields[0], "NAME") {
			headerIndex = i
			headers = fields
			break
		}
	}
	if headerIndex < 0 {
		return nil
	}
	indexOf := func(name string) int {
		for i, header := range headers {
			if strings.EqualFold(header, name) {
				return i
			}
		}
		return -1
	}
	valueAt := func(fields []string, index int) string {
		if index >= 0 && index < len(fields) {
			return fields[index]
		}
		return ""
	}
	var devices []BlockDeviceCard
	for _, line := range lines[headerIndex+1:] {
		fields := strings.Fields(string(line))
		if len(fields) == 0 || strings.EqualFold(fields[0], "NAME") {
			continue
		}
		device := BlockDeviceCard{
			Name:       valueAt(fields, indexOf("NAME")),
			Size:       valueAt(fields, indexOf("SIZE")),
			Type:       valueAt(fields, indexOf("TYPE")),
			FileSystem: valueAt(fields, indexOf("FSTYPE")),
			MountPoint: valueAt(fields, indexOf("MOUNTPOINT")),
			ReadOnly:   valueAt(fields, indexOf("RO")),
			Removable:  valueAt(fields, indexOf("RM")),
		}
		if device.MountPoint == "" {
			device.MountPoint = valueAt(fields, indexOf("MOUNTPOINTS"))
		}
		if device.Name == "" || device.Name == "NAME" {
			continue
		}
		if device.MountPoint == "" {
			device.MountPoint = "未挂载"
		}
		if device.ReadOnly == "1" {
			device.ReadOnly = "只读"
		} else if device.ReadOnly != "" {
			device.ReadOnly = "可写"
		}
		if device.Removable == "1" {
			device.Removable = "可移动"
		} else if device.Removable != "" {
			device.Removable = "固定设备"
		}
		devices = append(devices, device)
	}
	return devices
}

func parseIfconfig(content []byte) []NetworkInterfaceCard {
	interfacePattern := regexp.MustCompile(`^([^\s:]+):\s+.*(?:state\s+(\w+))?.*$`)
	inetPattern := regexp.MustCompile(`\binet\s+([^\s]+)`)
	inet6Pattern := regexp.MustCompile(`\binet6\s+([^\s]+)`)
	macPattern := regexp.MustCompile(`\b(?:ether|link/ether)\s+([^\s]+)`)
	mtuPattern := regexp.MustCompile(`\bmtu\s+(\d+)`)
	var interfaces []NetworkInterfaceCard
	for _, rawLine := range bytes.Split(content, []byte{'\n'}) {
		line := string(rawLine)
		if matches := interfacePattern.FindStringSubmatch(line); len(matches) > 0 && !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			interfaces = append(interfaces, NetworkInterfaceCard{Name: matches[1], State: matches[2]})
			continue
		}
		if len(interfaces) == 0 {
			continue
		}
		current := &interfaces[len(interfaces)-1]
		lower := strings.ToLower(line)
		if strings.Contains(lower, "no-carrier") {
			current.Carrier = "NO-CARRIER"
		}
		if strings.Contains(lower, "carrier") && current.Carrier == "" {
			current.Carrier = "CARRIER"
		}
		if match := inetPattern.FindStringSubmatch(line); len(match) > 1 {
			current.IPv4 = append(current.IPv4, match[1])
		}
		if match := inet6Pattern.FindStringSubmatch(line); len(match) > 1 {
			current.IPv6 = append(current.IPv6, match[1])
		}
		if match := macPattern.FindStringSubmatch(line); len(match) > 1 {
			current.MAC = match[1]
		}
		if match := mtuPattern.FindStringSubmatch(line); len(match) > 1 {
			current.MTU = match[1]
		}
	}
	for i := range interfaces {
		if interfaces[i].State == "DOWN" || interfaces[i].Carrier == "NO-CARRIER" {
			interfaces[i].Status = "风险"
		} else if interfaces[i].State == "UP" || len(interfaces[i].IPv4) > 0 || interfaces[i].Carrier == "CARRIER" {
			interfaces[i].Status = "正常"
		} else {
			interfaces[i].Status = "未知"
		}
	}
	return interfaces
}

func extractBlockDevices(results []Result) []BlockDeviceCard {
	var devices []BlockDeviceCard
	for _, result := range results {
		devices = append(devices, result.BlockDevices...)
	}
	return devices
}

// extractBlockDevicesRaw 保留 lsblk.log 原始内容，报告中直接展示，避免改变工程师熟悉的输出格式。
func extractBlockDevicesRaw(results []Result) string {
	for _, result := range results {
		if result.BlockDevicesRaw != "" {
			return result.BlockDevicesRaw
		}
	}
	return ""
}

// extractMemoryModules 汇总所有日志文件中的内存条摘要，并按三项展示字段去重。
func extractMemoryModules(results []Result) []MemoryModule {
	var modules []MemoryModule
	seen := make(map[string]bool)
	for _, result := range results {
		for _, module := range result.Memory {
			key := module.Size + "\x00" + module.Manufacturer + "\x00" + module.Model
			if seen[key] {
				continue
			}
			seen[key] = true
			modules = append(modules, module)
		}
	}
	return modules
}

func extractNetworks(results []Result) []NetworkInterfaceCard {
	var networks []NetworkInterfaceCard
	for _, result := range results {
		networks = append(networks, result.Networks...)
	}
	return networks
}
