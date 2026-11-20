// 局域网阅卷监控服务（Go 单文件实现，零依赖）
package main

import (
	"bufio"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const VERSION = "v1.1.9"

// 内置更新源（与插件同一个清单），没配置时默认用它
const BUILTIN_UPDATE_URL = "https://gh-proxy.com/https://raw.githubusercontent.com/zhaokelei/grade-assistant/main/update.json"

//go:embed page.html
var pageHTML string

var (
	mu       sync.RWMutex
	state    = map[string]interface{}{}
	imgMime  string
	imgData  []byte
	imgVer   = 0
	imgUploads = 0
	lastImgAt  int64
	clients  = map[chan string]struct{}{}
	clientMu sync.Mutex
)

var (
	updateURL   string
	autoUpdate  = false // 默认只提示，不强制更新
	needReload  bool
	updMu       sync.Mutex
	upd         updInfo
	updSkipped  bool
	pluginDir   string

	logMu   sync.Mutex
	logFile *os.File
)

// 同时输出到控制台和 monitor.log，控制台被关掉也能查
func logf(format string, a ...interface{}) {
	line := fmt.Sprintf(format, a...)

	logMu.Lock()
	defer logMu.Unlock()

	fmt.Println(line)
	if logFile != nil {
		fmt.Fprintf(logFile, "%s %s\n", time.Now().Format("01-02 15:04:05"), line)
		_ = logFile.Sync()
	}
}

type updInfo struct {
	Checked    bool     `json:"checked"`
	HasUpdate  bool     `json:"hasUpdate"`
	Latest     string   `json:"latest"`
	Notes      string   `json:"notes"`
	MonitorURL string   `json:"monitorUrl"`
	PluginBase string   `json:"pluginBase"`
	Files      []string `json:"pluginFiles"`
	Error      string   `json:"error"`
}

func initState() {
	state = map[string]interface{}{
		"status":          "等待插件连接…",
		"gradedCount":     0,
		"lastScore":       nil,
		"isAutoGrading":   false,
		"isPaused":        false,
		"totalScore":      0,
		"question":        "",
		"standardAnswer":  "",
		"scoringCriteria": "",
		"logs":            []interface{}{},
		"history":         []interface{}{},
		"imageVersion":    0,
		"streamText":      "",
		"updatedAt":       0,
	}
}

func snapshot() map[string]interface{} {
	mu.RLock()
	out := make(map[string]interface{}, len(state)+8)
	for k, v := range state {
		out[k] = v
	}
	mu.RUnlock()

	out["imageVersion"] = imgVer
	out["imageUploads"] = imgUploads
	out["lastImageAt"] = lastImgAt
	out["version"] = VERSION

	// 更新检查状态，页面据此显示「检查中 / 已是最新 / 发现新版本」
	updMu.Lock()
	out["updateChecked"] = upd.Checked
	out["updateHas"] = upd.HasUpdate
	out["updateLatest"] = upd.Latest
	out["updateNotes"] = upd.Notes
	out["updateSkipped"] = updSkipped
	out["updateError"] = upd.Error
	updMu.Unlock()

	out["autoUpdate"] = autoUpdate

	return out
}

func broadcast() {
	b, err := json.Marshal(snapshot())
	if err != nil {
		return
	}
	payload := "data: " + string(b) + "\n\n"
	clientMu.Lock()
	defer clientMu.Unlock()
	for ch := range clients {
		select {
		case ch <- payload:
		default:
		}
	}
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
}

// ---------------- 更新相关 ----------------

func appDir() string {
	exe, err := os.Executable()
	if err != nil || strings.Contains(exe, "go-build") {
		wd, _ := os.Getwd()
		return wd
	}
	return filepath.Dir(exe)
}

func updateConfPath() string { return filepath.Join(appDir(), "monitor-update.json") }

func loadUpdateConf() {
	b, err := os.ReadFile(updateConfPath())
	if err != nil {
		return
	}
	var c struct {
		UpdateURL  string `json:"updateUrl"`
		PluginDir  string `json:"pluginDir"`
		AutoUpdate *bool  `json:"autoUpdate"`
	}
	if json.Unmarshal(b, &c) != nil {
		return
	}
	updateURL = c.UpdateURL
	if c.PluginDir != "" {
		pluginDir = c.PluginDir
	}
	if c.AutoUpdate != nil {
		autoUpdate = *c.AutoUpdate
	}
}

func saveUpdateConf(url string) {
	c := map[string]interface{}{"updateUrl": url}
	if pluginDir != "" {
		c["pluginDir"] = pluginDir
	}
	c["autoUpdate"] = autoUpdate
	b, _ := json.MarshalIndent(c, "", "  ")
	_ = os.WriteFile(updateConfPath(), b, 0644)
}

func compareVer(a, b string) int {
	pa := strings.Split(strings.TrimPrefix(strings.ToLower(a), "v"), ".")
	pb := strings.Split(strings.TrimPrefix(strings.ToLower(b), "v"), ".")
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		var x, y int
		if i < len(pa) {
			fmt.Sscanf(pa[i], "%d", &x)
		}
		if i < len(pb) {
			fmt.Sscanf(pb[i], "%d", &y)
		}
		if x > y {
			return 1
		}
		if x < y {
			return -1
		}
	}
	return 0
}

var httpClient = &http.Client{Timeout: 20 * time.Second}

func checkUpdate() map[string]interface{} {
	updMu.Lock()
	defer updMu.Unlock()

	if updateURL == "" {
		upd = updInfo{Checked: true, Error: "未配置更新源"}
		return map[string]interface{}{"success": false, "error": "未配置更新源", "current": VERSION}
	}

	sep := "?"
	if strings.Contains(updateURL, "?") {
		sep = "&"
	}
	resp, err := httpClient.Get(updateURL + sep + "t=" + fmt.Sprint(time.Now().UnixMilli()))
	if err != nil {
		upd = updInfo{Checked: true, Error: err.Error()}
		return map[string]interface{}{"success": false, "error": err.Error(), "current": VERSION}
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		msg := "更新源返回 " + resp.Status
		upd = updInfo{Checked: true, Error: msg}
		return map[string]interface{}{"success": false, "error": msg, "current": VERSION}
	}

	var d struct {
		Version    string   `json:"version"`
		Notes      string   `json:"notes"`
		MonitorURL string   `json:"monitorUrl"`
		PluginBase string   `json:"pluginBase"`
		Files      []string `json:"pluginFiles"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		upd = updInfo{Checked: true, Error: "更新源格式错误"}
		return map[string]interface{}{"success": false, "error": "更新源格式错误", "current": VERSION}
	}

	latest := strings.TrimPrefix(d.Version, "v")
	if latest == "" {
		upd = updInfo{Checked: true, Error: "更新源缺少 version"}
		return map[string]interface{}{"success": false, "error": "更新源缺少 version", "current": VERSION}
	}

	has := compareVer(latest, VERSION) > 0
	upd = updInfo{Checked: true, HasUpdate: has, Latest: latest, Notes: d.Notes, MonitorURL: d.MonitorURL, PluginBase: d.PluginBase, Files: d.Files}

	return map[string]interface{}{
		"success":   true,
		"current":   VERSION,
		"latest":    latest,
		"hasUpdate": has,
		"notes":     d.Notes,
	}
}

// 找插件目录：配置 > exe 同级 > 桌面\pg > 桌面
func resolvePluginDir() string {
	if pluginDir != "" {
		if _, err := os.Stat(filepath.Join(pluginDir, "manifest.json")); err == nil {
			return pluginDir
		}
	}

	home, _ := os.UserHomeDir()
	cands := []string{
		filepath.Join(appDir(), "auto-grader-extension"),
		filepath.Join(home, "Desktop", "pg", "auto-grader-extension"),
		filepath.Join(home, "Desktop", "auto-grader-extension"),
		filepath.Join(home, "Documents", "auto-grader-extension"),
	}
	for _, c := range cands {
		if _, err := os.Stat(filepath.Join(c, "manifest.json")); err == nil {
			pluginDir = c
			return c
		}
	}
	return ""
}

func fetchWithRetry(url string) ([]byte, error) {
	ua := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", ua)
		req.Header.Set("Referer", "https://github.com/")

		resp, err := httpClient.Do(req)
		if err == nil {
			if resp.StatusCode == 200 {
				b, err := io.ReadAll(resp.Body)
				resp.Body.Close()
				if err != nil {
					return nil, err
				}
				return b, nil
			}
			code := resp.StatusCode
			resp.Body.Close()
			lastErr = fmt.Errorf("HTTP %d", code)
			if code == 429 || code == 451 || code >= 500 {
				time.Sleep(time.Duration(900*(attempt+1)) * time.Millisecond)
				continue
			}
			return nil, lastErr
		}
		lastErr = err
		time.Sleep(time.Duration(600*(attempt+1)) * time.Millisecond)
	}
	return nil, lastErr
}

// 下载插件文件：先全下到临时目录，再整体覆盖
func updatePluginFiles() (map[string]interface{}, error) {
	updMu.Lock()
	info := upd
	updMu.Unlock()

	if info.PluginBase == "" || len(info.Files) == 0 {
		return nil, fmt.Errorf("更新源未提供插件文件清单")
	}

	dir := resolvePluginDir()
	if dir == "" {
		return nil, fmt.Errorf("未找到插件目录")
	}

	tmp := filepath.Join(appDir(), "plugin-update-tmp")
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0755); err != nil {
		return nil, err
	}

	base := strings.TrimRight(info.PluginBase, "/")

	for _, name := range info.Files {
		b, err := fetchWithRetry(base + "/" + name)
		if err != nil {
			_ = os.RemoveAll(tmp)
			return nil, fmt.Errorf("下载 %s 失败（%v）", name, err)
		}
		if len(b) == 0 {
			_ = os.RemoveAll(tmp)
			return nil, fmt.Errorf("%s 内容为空", name)
		}
		if err := os.WriteFile(filepath.Join(tmp, name), b, 0644); err != nil {
			_ = os.RemoveAll(tmp)
			return nil, err
		}
		time.Sleep(200 * time.Millisecond) // 控制节奏，避免被限流
	}

	for _, name := range info.Files {
		if err := os.WriteFile(filepath.Join(dir, name), mustRead(filepath.Join(tmp, name)), 0644); err != nil {
			return nil, err
		}
	}
	_ = os.RemoveAll(tmp)

	needReload = true

	return map[string]interface{}{
		"success": true,
		"dir":     dir,
		"files":   len(info.Files),
		"version": info.Latest,
	}, nil
}

func mustRead(p string) []byte {
	b, _ := os.ReadFile(p)
	return b
}

// 下载新 exe，写替换脚本并退出
func applySelfUpdate() (map[string]interface{}, error) {
	updMu.Lock()
	info := upd
	updMu.Unlock()

	if !info.HasUpdate || info.MonitorURL == "" {
		return nil, fmt.Errorf("没有可用的更新")
	}

	pluginResult, pluginErr := updatePluginFiles()

	b, err := fetchWithRetry(info.MonitorURL)
	if err != nil {
		return map[string]interface{}{"success": false, "error": "下载监控程序失败：" + err.Error()}, nil
	}
	if len(b) < 1<<20 {
		return map[string]interface{}{"success": false, "error": fmt.Sprintf("下载文件异常（%d 字节）", len(b))}, nil
	}

	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	dir := filepath.Dir(exe)
	tmpExe := filepath.Join(dir, "update-new.exe")

	if err := os.WriteFile(tmpExe, b, 0755); err != nil {
		return map[string]interface{}{"success": false, "error": "写入新版本失败：" + err.Error()}, nil
	}

	bat := filepath.Join(dir, "apply-update.bat")
	lines := []string{
		"@echo off",
		"timeout /t 2 /nobreak >nul",
		`move /y "` + tmpExe + `" "` + exe + `"`,
		`start "" "` + exe + `"`,
		`del "%~f0"`,
	}
	_ = os.WriteFile(bat, []byte(strings.Join(lines, "\r\n")), 0644)

	cmd := exec.Command("cmd.exe", "/c", bat)
	if err := cmd.Start(); err != nil {
		return map[string]interface{}{"success": false, "error": "启动更新脚本失败：" + err.Error()}, nil
	}

	go func() {
		time.Sleep(400 * time.Millisecond)
		os.Exit(0)
	}()

	res := map[string]interface{}{"success": true, "version": info.Latest}
	if pluginErr == nil && pluginResult != nil {
		res["plugin"] = pluginResult
	} else if pluginErr != nil {
		res["plugin"] = map[string]interface{}{"success": false, "error": pluginErr.Error()}
	}
	return res, nil
}

// 检查更新并把结果显示出来（启动时和定时任务都走这里）
func runAutoUpdate() {
	logf("[更新] 正在检查更新…")

	r := checkUpdate()

	if ok, _ := r["success"].(bool); !ok {
		logf("[更新] 检查失败：%v", r["error"])
		broadcast()
		return
	}

	if has, _ := r["hasUpdate"].(bool); !has {
		logf("[更新] 已是最新版本 %s，正常启动", VERSION)
		broadcast()
		return
	}

	latest := fmt.Sprint(r["latest"])
	logf("[更新] 发现新版本 v%s（当前 %s）", latest, VERSION)
	if notes := fmt.Sprint(r["notes"]); notes != "" && notes != "<nil>" {
		logf("[更新] 更新内容：%s", notes)
	}
	broadcast()

	// 默认不强制更新：控制台给 1/2 选择，页面也有按钮
	if autoUpdate {
		logf("[更新] 自动更新已开启，3 秒后开始更新…")
		time.Sleep(3 * time.Second)
		doSelfUpdate()
		return
	}

	logf("[更新] 1 = 立即更新    2 = 跳过继续（30 秒不操作自动跳过）")
	go promptUpdateChoice()
}

// 控制台交互：等待用户输入 1 或 2
func promptUpdateChoice() {
	type result struct {
		line string
		err  error
	}
	ch := make(chan result, 1)

	go func() {
		reader := bufio.NewReader(os.Stdin)
		line, err := reader.ReadString('\n')
		ch <- result{line: line, err: err}
	}()

	select {
	case res := <-ch:
		choice := strings.TrimSpace(res.line)
		if choice == "1" {
			logf("[更新] 开始更新…")
			doSelfUpdate()
			return
		}
		logf("[更新] 已选择跳过，继续运行 %s", VERSION)
		skipUpdate()

	case <-time.After(30 * time.Second):
		logf("[更新] 30 秒未操作，已跳过本次更新")
		skipUpdate()
	}
}

func skipUpdate() {
	updMu.Lock()
	updSkipped = true
	updMu.Unlock()
	broadcast()
}

// 真正执行更新：一次调用同时更新插件与监控程序自身
func doSelfUpdate() {
	logf("[更新] 开始更新（插件 + 监控程序）")

	res, err := applySelfUpdate()
	if err != nil {
		logf("[更新] 失败：%v", err)
		return
	}

	if ok, _ := res["success"].(bool); !ok {
		logf("[更新] 失败：%v", res["error"])
		return
	}

	// 插件那半边的结果
	if pl, ok := res["plugin"].(map[string]interface{}); ok {
		if pok, _ := pl["success"].(bool); pok {
			logf("[更新] 插件已更新 %v 个文件 → %v（扩展会自行重载）", pl["files"], pl["dir"])
		} else {
			logf("[更新] 插件更新失败：%v", pl["error"])
		}
	}

	logf("[更新] 监控程序已下载，正在替换并重启…")
}

// ---------------- HTTP 处理 ----------------

func handler(w http.ResponseWriter, r *http.Request) {
	cors(w)

	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}

	p := r.URL.Path

	switch {
	case p == "/" || p == "/index.html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, pageHTML)

	case p == "/api/status" && r.Method == "POST":
		var data map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
			writeJSON(w, 400, map[string]bool{"ok": false})
			return
		}
		mu.Lock()
		fresh := make(map[string]interface{}, len(data))
		for k, v := range data {
			fresh[k] = v
		}
		fresh["updatedAt"] = time.Now().UnixMilli()
		fresh["imageVersion"] = imgVer
		state = fresh
		mu.Unlock()
		broadcast()
		writeJSON(w, 200, map[string]bool{"ok": true})

	case p == "/api/status" && r.Method == "GET":
		writeJSON(w, 200, snapshot())

	case p == "/api/stream":
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, 500, map[string]string{"error": "stream unsupported"})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(200)

		ch := make(chan string, 8)
		clientMu.Lock()
		clients[ch] = struct{}{}
		clientMu.Unlock()

		b, _ := json.Marshal(snapshot())
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()

		defer func() {
			clientMu.Lock()
			delete(clients, ch)
			clientMu.Unlock()
		}()

		ping := time.NewTicker(25 * time.Second)
		defer ping.Stop()

		for {
			select {
			case msg := <-ch:
				if _, err := io.WriteString(w, msg); err != nil {
					return
				}
				flusher.Flush()
			case <-ping.C:
				if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
					return
				}
				flusher.Flush()
			case <-r.Context().Done():
				return
			}
		}

	case p == "/api/image" && r.Method == "POST":
		var body struct {
			Image string `json:"image"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]bool{"ok": false})
			return
		}
		s := body.Image
		i := strings.Index(s, "base64,")
		if !strings.HasPrefix(s, "data:image/") || i < 0 {
			writeJSON(w, 400, map[string]bool{"ok": false})
			return
		}
		mime := s[5:i]
		raw, err := base64.StdEncoding.DecodeString(s[i+7:])
		if err != nil {
			writeJSON(w, 400, map[string]bool{"ok": false})
			return
		}
		mu.Lock()
		imgMime = mime
		imgData = raw
		imgVer++
		imgUploads++
		lastImgAt = time.Now().UnixMilli()
		v := imgVer
		mu.Unlock()
		broadcast()
		writeJSON(w, 200, map[string]interface{}{"ok": true, "version": v})

	case p == "/api/image" && r.Method == "GET":
		mu.RLock()
		data, mime := imgData, imgMime
		mu.RUnlock()
		if data == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(200)
		_, _ = w.Write(data)

	case p == "/api/update-config" && r.Method == "POST":
		var body struct {
			UpdateURL string `json:"updateUrl"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		updateURL = strings.TrimSpace(body.UpdateURL)
		saveUpdateConf(updateURL)
		writeJSON(w, 200, map[string]interface{}{"ok": true, "updateUrl": updateURL})

	case p == "/api/update" && r.Method == "GET":
		writeJSON(w, 200, checkUpdate())

	case p == "/api/update/apply" && r.Method == "POST":
		res, err := applySelfUpdate()
		if err != nil {
			writeJSON(w, 200, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, res)

	// 用户选择「跳过本次更新」
	case p == "/api/update/skip" && r.Method == "POST":
		skipUpdate()
		writeJSON(w, 200, map[string]bool{"ok": true})

	case p == "/api/update/plugin" && r.Method == "POST":
		res, err := updatePluginFiles()
		if err != nil {
			writeJSON(w, 200, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, res)

	case p == "/api/plugin-version" && r.Method == "GET":
		writeJSON(w, 200, map[string]interface{}{
			"latest":    upd.Latest,
			"needReload": needReload,
			"pluginDir": resolvePluginDir(),
			"hasUpdate": upd.HasUpdate,
		})

	case p == "/api/plugin-reloaded" && r.Method == "POST":
		needReload = false
		writeJSON(w, 200, map[string]bool{"ok": true})

	default:
		http.NotFound(w, r)
	}
}

func lanIPs() []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, i := range ifaces {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := i.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			if ip.To4() != nil {
				out = append(out, ip.String())
			}
		}
	}
	return out
}

func main() {
	initState()
	loadUpdateConf()
	if updateURL == "" {
		updateURL = BUILTIN_UPDATE_URL
	}

	// 日志同时落盘，控制台被关掉也能事后查
	if f, err := os.OpenFile(filepath.Join(appDir(), "monitor.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644); err == nil {
		logFile = f
		defer f.Close()
	}

	port := os.Getenv("MONITOR_PORT")
	if port == "" {
		port = "8090"
	}

	http.HandleFunc("/", handler)
	go func() {
		logf("阅卷监控服务已启动 %s", VERSION)
		logf("")
		logf("  电脑访问：http://127.0.0.1:" + port)
		for _, ip := range lanIPs() {
			logf("  手机访问：http://" + ip + ":" + port)
		}
		logf("")
		logf("手机需与电脑连同一 Wi-Fi。若手机打不开，请在 Windows 防火墙中允许本程序访问网络。")
		logf("")

		if updateURL == "" {
			logf("[更新] 未配置更新源，跳过检查")
			return
		}

		logf("[更新] 更新源：%s", updateURL)
		logf("[更新] 自动安装：%v（false = 只提示，需手动确认）", autoUpdate)

		// 启动后 3 秒检查一次，之后每 30 分钟一次
		time.Sleep(3 * time.Second)
		runAutoUpdate()

		for {
			time.Sleep(30 * time.Minute)
			runAutoUpdate()
		}
	}()

	if err := http.ListenAndServe("0.0.0.0:"+port, nil); err != nil {
		logf("启动失败：%v", err)
		os.Exit(1)
	}
}
