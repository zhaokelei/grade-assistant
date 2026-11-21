// 极简 FTP 客户端：只做「下载一个文件」，支持 PASV 模式与账号认证
package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

type ftpConn struct {
	conn    net.Conn
	rd      *bufio.Reader
	typeSet bool
}

// 读一条响应；多行响应（1xx- ... 1xx ）会读到最后一行
func (f *ftpConn) readResp() (int, string, error) {
	line, err := f.rd.ReadString('\n')
	if err != nil {
		return 0, "", err
	}

	line = strings.TrimRight(line, "\r\n")
	if len(line) < 3 {
		return 0, line, fmt.Errorf("FTP 响应异常：%s", line)
	}

	code, err := strconv.Atoi(line[:3])
	if err != nil {
		return 0, line, fmt.Errorf("FTP 响应异常：%s", line)
	}

	lines := []string{line}

	if len(line) > 3 && line[3] == '-' {
		prefix := line[:3] + " "
		for {
			l, err := f.rd.ReadString('\n')
			if err != nil {
				return code, strings.Join(lines, "\n"), err
			}
			l = strings.TrimRight(l, "\r\n")
			lines = append(lines, l)
			if strings.HasPrefix(l, prefix) {
				break
			}
		}
	}

	return code, strings.Join(lines, "\n"), nil
}

func (f *ftpConn) cmd(format string, a ...interface{}) (int, string, error) {
	if _, err := fmt.Fprintf(f.conn, format+"\r\n", a...); err != nil {
		return 0, "", err
	}
	return f.readResp()
}

func (f *ftpConn) login(user, pass string) error {
	code, msg, err := f.cmd("USER %s", user)
	if err != nil {
		return err
	}

	if code == 331 {
		code, msg, err = f.cmd("PASS %s", pass)
		if err != nil {
			return err
		}
	}

	if code != 230 {
		return fmt.Errorf("FTP 登录失败：%s", msg)
	}
	return nil
}

// 解析 227 响应里的数据端口
func parsePasv(msg, fallbackHost string) (string, string, error) {
	nums := ""

	if s := strings.Index(msg, "("); s >= 0 {
		if e := strings.Index(msg, ")"); e > s {
			nums = msg[s+1 : e]
		}
	}

	if nums == "" {
		for _, field := range strings.Fields(msg) {
			if strings.Count(field, ",") == 5 {
				nums = field
				break
			}
		}
	}

	if nums == "" {
		return "", "", fmt.Errorf("FTP PASV 解析失败：%s", msg)
	}

	parts := strings.Split(nums, ",")
	if len(parts) != 6 {
		return "", "", fmt.Errorf("FTP PASV 格式错误：%s", nums)
	}

	host := strings.Join(parts[0:4], ".")
	p1, _ := strconv.Atoi(strings.TrimSpace(parts[4]))
	p2, _ := strconv.Atoi(strings.TrimSpace(parts[5]))
	port := p1*256 + p2

	// 很多 FTP 服务端在 PASV 里返回内网地址，此时要用控制连接的对端地址
	if ip := net.ParseIP(host); ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsUnspecified()) {
		host = fallbackHost
	}

	if port <= 0 || port > 65535 {
		return "", "", fmt.Errorf("FTP 数据端口异常：%d", port)
	}

	return host, strconv.Itoa(port), nil
}

func (f *ftpConn) retr(path string) ([]byte, error) {
	if !f.typeSet {
		if code, msg, err := f.cmd("TYPE I"); err != nil {
			return nil, err
		} else if code != 200 {
			return nil, fmt.Errorf("FTP 切换二进制模式失败：%s", msg)
		}
		f.typeSet = true
	}

	code, msg, err := f.cmd("PASV")
	if err != nil {
		return nil, err
	}
	if code != 227 {
		return nil, fmt.Errorf("FTP 进入被动模式失败：%s", msg)
	}

	controlHost, _, _ := net.SplitHostPort(f.conn.RemoteAddr().String())
	host, port, err := parsePasv(msg, controlHost)
	if err != nil {
		return nil, err
	}

	dataConn, err := net.DialTimeout("tcp", net.JoinHostPort(host, port), 20*time.Second)
	if err != nil {
		return nil, err
	}
	defer dataConn.Close()

	code, msg, err = f.cmd("RETR %s", path)
	if err != nil {
		return nil, err
	}
	if code != 150 && code != 125 {
		return nil, fmt.Errorf("FTP 读取 %s 失败：%s", path, msg)
	}

	body, err := io.ReadAll(io.LimitReader(dataConn, 200<<20))
	if err != nil {
		return nil, err
	}

	// 收尾的 226，失败也不影响已拿到的内容
	_, _, _ = f.readResp()

	if len(body) == 0 {
		return nil, fmt.Errorf("FTP 文件为空：%s", path)
	}

	return body, nil
}

// 下载一个 FTP 文件
func ftpDownload(host, user, pass, path string, timeout time.Duration) ([]byte, error) {
	conn, err := net.DialTimeout("tcp", host, timeout)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	f := &ftpConn{conn: conn, rd: bufio.NewReader(conn)}

	if _, _, err := f.readResp(); err != nil {
		return nil, err
	}
	if err := f.login(user, pass); err != nil {
		return nil, err
	}

	return f.retr(path)
}

// 批量下载：复用同一个控制连接，避免每个文件都重新登录
func ftpDownloadMany(host, user, pass, basePath string, names []string, timeout time.Duration) (map[string][]byte, error) {
	conn, err := net.DialTimeout("tcp", host, timeout)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	f := &ftpConn{conn: conn, rd: bufio.NewReader(conn)}
	if _, _, err := f.readResp(); err != nil {
		return nil, err
	}
	if err := f.login(user, pass); err != nil {
		return nil, err
	}

	out := make(map[string][]byte, len(names))
	base := strings.TrimRight(basePath, "/")

	for _, name := range names {
		b, err := f.retr(base + "/" + name)
		if err != nil {
			return nil, err
		}
		out[name] = b
	}

	return out, nil
}
