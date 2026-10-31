// Package diagnostics persists bounded structured logs and exports local runtime diagnostics.
package diagnostics

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"runtime/pprof"
	"sync"
	"time"
)

const maxFileBytes = 8 << 20

type Recorder struct {
	exportMu   sync.Mutex
	log        *rotatingLog
	logger     *slog.Logger
	component  string
	revision   string
	started    time.Time
	context    map[string]any
	closed     bool
	exportPath string
}

// Open appends to the component's current log, retaining one rotated backup.
// Callers own the directory choice and must pass sanitized structured events.
func Open(directory, component, revision string) (*Recorder, error) {
	if component != "client" && component != "server" {
		return nil, errors.New("diagnostics component must be client or server")
	}
	if directory == "" {
		return nil, errors.New("diagnostics directory is empty")
	}
	directory, err := filepath.Abs(directory)
	if err != nil {
		return nil, fmt.Errorf("resolve diagnostics directory: %w", err)
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, fmt.Errorf("create diagnostics directory: %w", err)
	}
	path := filepath.Join(directory, component+".log")
	for _, name := range []string{path, path + ".1"} {
		if err := checkLogFile(name); err != nil {
			return nil, err
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, fmt.Errorf("open diagnostics log: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		return nil, errors.Join(err, file.Close())
	}
	_, backupErr := os.Stat(path + ".1")
	log := &rotatingLog{file: file, path: path, size: info.Size(), preexisting: info.Size() > 0 || backupErr == nil}
	return &Recorder{
		log: log, logger: slog.New(slog.NewJSONHandler(log, &slog.HandlerOptions{Level: slog.LevelDebug, ReplaceAttr: ReplaceAttr})),
		component: component, revision: revision, started: time.Now(),
	}, nil
}

func (r *Recorder) Logger() *slog.Logger { return r.logger }
func (r *Recorder) LogPath() string      { return r.log.path }

// LastExportPath returns the latest successfully closed archive, including after Close.
func (r *Recorder) LastExportPath() string {
	r.exportMu.Lock()
	defer r.exportMu.Unlock()
	return r.exportPath
}

// Context snapshots explicitly selected startup facts; it never reads environment files.
func (r *Recorder) Context(name string, value any) {
	r.exportMu.Lock()
	defer r.exportMu.Unlock()
	if r.context == nil {
		r.context = make(map[string]any)
	}
	r.context[name] = ReplaceAttr(nil, slog.Any(name, value)).Value.Any()
}

// Binary records only the identity of an explicitly selected runtime executable.
func (r *Recorder) Binary(name, path string) {
	if path == "" {
		return
	}
	identity := map[string]any{"name": filepath.Base(path)}
	file, err := os.Open(path)
	if err == nil {
		hash := sha256.New()
		var size int64
		size, err = io.Copy(hash, file)
		_ = file.Close()
		if err == nil {
			identity["bytes"], identity["sha256"] = size, fmt.Sprintf("%x", hash.Sum(nil))
		}
	}
	if err != nil {
		identity["error"] = SafeText(err.Error())
	}
	r.Context(name, identity)
}

// Export retains useful evidence even when an optional collector fails. It never
// forces GC or collects raw process memory, media or arbitrary directory contents.
func (r *Recorder) Export() (path string, returnedErr error) {
	r.exportMu.Lock()
	defer r.exportMu.Unlock()
	if r.closed {
		return "", os.ErrClosed
	}
	now := time.Now()
	reportID := fmt.Sprintf("%d-%d", os.Getpid(), now.UnixNano())
	r.logger.Debug("diagnostic-report", "reportId", reportID)
	logs, logErr := r.log.snapshot()
	collectorErrors := []string{}
	if logErr != nil {
		collectorErrors = append(collectorErrors, SafeText(logErr.Error()))
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	file, err := os.CreateTemp(filepath.Dir(r.LogPath()), r.component+"-diagnostics-"+now.UTC().Format("20060102T150405Z")+"-*.zip")
	if err != nil {
		return "", fmt.Errorf("create diagnostics archive: %w", err)
	}
	archive := zip.NewWriter(file)
	defer func() {
		returnedErr = errors.Join(returnedErr, archive.Close(), file.Sync(), file.Close())
		if returnedErr != nil {
			returnedErr = errors.Join(returnedErr, os.Remove(file.Name()))
			path = ""
		} else {
			r.exportPath = path
		}
	}()
	files := []string{}
	add := func(name string, data []byte) error {
		entry, err := archive.Create(name)
		if err != nil {
			return err
		}
		if _, err := entry.Write(data); err != nil {
			return err
		}
		files = append(files, name)
		return nil
	}
	for _, log := range logs {
		if err := add(log.name, log.data); err != nil {
			return "", err
		}
	}
	for _, item := range []struct {
		name  string
		value any
	}{{"context.json", r.context}, {"memory.json", memory}} {
		data, err := json.MarshalIndent(item.value, "", "  ")
		if err != nil {
			collectorErrors = append(collectorErrors, item.name+": "+SafeText(err.Error()))
			continue
		}
		if err := add(item.name, data); err != nil {
			return "", err
		}
	}
	for _, profile := range []struct {
		name  string
		file  string
		debug int
	}{{"heap", "heap.pprof", 0}, {"goroutine", "goroutines.txt", 1}} {
		var data bytes.Buffer
		if err := pprof.Lookup(profile.name).WriteTo(&boundedWriter{writer: &data, remaining: maxFileBytes}, profile.debug); err != nil {
			collectorErrors = append(collectorErrors, profile.file+": "+SafeText(err.Error()))
			continue
		}
		if err := add(profile.file, data.Bytes()); err != nil {
			return "", err
		}
	}
	if err := add("README.txt", []byte("Piik diagnostic report / Piik 诊断报告\n\n"+
		"Local opt-in report. Review before sharing: technical identifiers, paths and network/system details may remain.\n"+
		"Credentials are filtered; raw media and process-memory contents are not collected. heap.pprof is an allocation profile.\n"+
		"metadata.json lists retained files and collector failures. Rotated logs are a bounded history, not the entire session.\n\n"+
		"本报告由本机主动导出。分享前请检查：可能含技术标识、路径和网络/系统信息。\n"+
		"凭据已过滤；不采集原始媒体或进程内存内容。heap.pprof 是分配统计。\n"+
		"metadata.json 记录文件及采集失败；轮转日志只保留有限历史。\n")); err != nil {
		return "", err
	}
	retention := r.log.retention()
	metadata := map[string]any{
		"component": r.component, "revision": r.revision, "goos": runtime.GOOS,
		"goarch": runtime.GOARCH, "goVersion": runtime.Version(), "collectedAt": now.UTC(),
		"startedAt": r.started.UTC(), "uptimeSeconds": now.Sub(r.started).Seconds(),
		"reportId": reportID, "pid": os.Getpid(), "cpuCount": runtime.NumCPU(),
		"gomaxprocs": runtime.GOMAXPROCS(0), "goroutineCount": runtime.NumGoroutine(),
		"files": append(files, "metadata.json"), "collectorErrors": collectorErrors,
		"partial": len(collectorErrors) > 0 || retention["earlierHistoryMayBeMissing"] == true, "logRetention": retention,
	}
	if build, ok := debug.ReadBuildInfo(); ok {
		metadata["mainModule"], metadata["dependencies"] = build.Main, build.Deps
	}
	data, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return "", err
	}
	if err := add("metadata.json", data); err != nil {
		return "", err
	}
	return file.Name(), nil
}

// Close waits for an export already in progress. It is safe to call repeatedly.
func (r *Recorder) Close() error {
	r.exportMu.Lock()
	defer r.exportMu.Unlock()
	r.closed = true
	r.log.mu.Lock()
	defer r.log.mu.Unlock()
	if r.log.file != nil {
		r.log.err = errors.Join(r.log.err, r.log.file.Sync(), r.log.file.Close())
		r.log.file = nil
	}
	return r.log.err
}

type rotatingLog struct {
	mu          sync.Mutex
	file        *os.File
	path        string
	size        int64
	err         error
	rotations   uint64
	preexisting bool
}

func (l *rotatingLog) Write(data []byte) (n int, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return 0, os.ErrClosed
	}
	// slog discards handler errors; retain the first failure for Export and Close.
	defer func() {
		if err != nil && l.err == nil {
			l.err = err
		}
	}()
	if len(data) > maxFileBytes {
		return 0, errors.New("diagnostics log record exceeds 8 MiB")
	}
	if l.size+int64(len(data)) > maxFileBytes {
		if err := l.rotate(); err != nil {
			return 0, err
		}
	}
	n, err = l.file.Write(data)
	l.size += int64(n)
	return n, err
}

func (l *rotatingLog) rotate() error {
	err := l.file.Close()
	l.file = nil
	if err != nil {
		return err
	}
	if err := os.Remove(l.path + ".1"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(l.path, l.path+".1"); err != nil {
		return err
	}
	l.file, err = os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	l.size = 0
	if err == nil {
		l.rotations++
	}
	return err
}

func (l *rotatingLog) retention() map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	return map[string]any{"fileBytesLimit": maxFileBytes, "fileCountLimit": 2,
		"rotationsThisProcess": l.rotations, "preexistingHistory": l.preexisting,
		"earlierHistoryMayBeMissing": l.preexisting || l.rotations > 0}
}

type logSnapshot struct {
	name string
	data []byte
}

func (l *rotatingLog) snapshot() ([]logSnapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	issues := []error{l.err}
	if l.file != nil {
		issues = append(issues, l.file.Sync())
	}
	// ponytail: at most 16 MiB copied under the log lock; compression runs outside it.
	var logs []logSnapshot
	for _, path := range []string{l.path + ".1", l.path} {
		if err := checkLogFile(path); err != nil {
			issues = append(issues, err)
			continue
		}
		file, err := os.Open(path)
		if errors.Is(err, os.ErrNotExist) && path != l.path {
			continue
		}
		if err != nil {
			issues = append(issues, err)
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maxFileBytes+1))
		if err := errors.Join(readErr, file.Close()); err != nil {
			issues = append(issues, err)
			continue
		}
		if len(data) > maxFileBytes {
			issues = append(issues, errors.New("diagnostics log exceeds 8 MiB"))
			continue
		}
		logs = append(logs, logSnapshot{filepath.Base(path), data})
	}
	return logs, errors.Join(issues...)
}

func checkLogFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > maxFileBytes {
		return fmt.Errorf("diagnostics log %q must be a regular file no larger than 8 MiB", path)
	}
	return nil
}

type boundedWriter struct {
	writer    io.Writer
	remaining int
}

func (w *boundedWriter) Write(data []byte) (int, error) {
	if len(data) > w.remaining {
		return 0, errors.New("diagnostics profile exceeds 8 MiB")
	}
	n, err := w.writer.Write(data)
	w.remaining -= n
	return n, err
}
