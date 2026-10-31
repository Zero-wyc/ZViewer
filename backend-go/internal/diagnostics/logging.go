package diagnostics

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"syscall"

	"github.com/go-logr/logr"
	medialog "github.com/livekit/protocol/logger"
	"github.com/pion/logging"
	"go.uber.org/zap/zapcore"
)

const maxLineBytes = 64 << 10

var (
	privateKey               = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`)
	bearer                   = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+`)
	secretPair               = regexp.MustCompile(`(?i)((?:[a-z_-]*(?:password|passwd|pwd|ufrag|credential|token|secret|authorization|cookie)|a=ice-(?:pwd|ufrag))["']?\s*[:=]\s*["']?)([^\s,"';}]+)`)
	urlCredentials           = regexp.MustCompile(`(?i)(https?|wss?)://[^\s/@]+:[^\s/@]+@`)
	inviteFragment           = regexp.MustCompile(`(?i)(https?://[^\s#"']+)#[^\s"']*`)
	diagnosticID             = regexp.MustCompile(`^id-[0-9a-f]{16}$`)
	iceUsernameMismatch      = regexp.MustCompile(`(?i)(username[^\r\n]*?expected\()[0-9a-f]+(\)\s+actual\()[0-9a-f]+(\))`)
	iceUfragExtension        = regexp.MustCompile(`(?i)(\bufrag\s+)[A-Za-z0-9+/=_-]+`)
	iceUnlabelledCredentials = regexp.MustCompile(`(?i)((?:get(?: all)? TCP connections by ufrag|get port of UDPAddr from ListenUDPInPortRange):)[^\r\n]*`)
	remoteTrackDump          = regexp.MustCompile(`(?i)got new track:[^\r\n]*`)
)

// SafeText preserves technical causes and system codes, not authentication material.
// It is deliberately not a promise to anonymize system paths or network addresses.
func SafeText(text string) string {
	text = privateKey.ReplaceAllString(text, "[private key redacted]")
	text = remoteTrackDump.ReplaceAllString(text, "got new track: [opaque object omitted; see RTP statistics]")
	// Pinned Pion also reports ICE usernames as hex and unlabelled candidate extensions.
	text = iceUsernameMismatch.ReplaceAllString(text, "${1}[redacted]${2}[redacted]${3}")
	text = iceUnlabelledCredentials.ReplaceAllString(text, "${1} [redacted ICE credentials]")
	text = iceUfragExtension.ReplaceAllString(text, "${1}[redacted]")
	text = bearer.ReplaceAllString(text, "$1 [redacted]")
	text = secretPair.ReplaceAllString(text, "${1}[redacted]")
	text = urlCredentials.ReplaceAllString(text, "$1://[redacted]@")
	return inviteFragment.ReplaceAllString(text, "$1#[redacted]")
}

// ID permits matching one opaque media identity across separately exported reports.
func ID(value string) string {
	if value == "" || diagnosticID.MatchString(value) {
		return value
	}
	sum := sha256.Sum256([]byte(value))
	return fmt.Sprintf("id-%x", sum[:8])
}

func Error(err error) slog.Attr {
	if err == nil {
		return slog.Attr{}
	}
	fields := []any{"type", fmt.Sprintf("%T", err), "message", SafeText(err.Error())}
	var code syscall.Errno
	if errors.As(err, &code) {
		fields = append(fields, "systemCode", uint64(code))
	}
	return slog.Group("error", fields...)
}

func privateField(key string) bool {
	key = strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(key))
	return strings.Contains(key, "password") || strings.Contains(key, "token") ||
		strings.Contains(key, "secret") || strings.Contains(key, "privatekey") ||
		key == "authorization" || key == "cookie" || key == "setcookie" ||
		strings.HasSuffix(key, "pwd") || strings.HasSuffix(key, "ufrag") || key == "sdp" || key == "credential"
}

func identityField(key string) bool {
	switch strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(key)) {
	case "peerid", "shareid", "connectionid", "trackid", "streamid", "subid", "publicationgeneration", "sid", "trackidentifier", "rtpstatsid", "rtcpeerid":
		return true
	}
	return false
}

func safeValue(key string, value any) any {
	if privateField(key) {
		return "[redacted]"
	}
	switch value := value.(type) {
	case string:
		if identityField(key) {
			return ID(value)
		}
		return SafeText(value)
	case map[string]any:
		for name, field := range value {
			value[name] = safeValue(name, field)
		}
	case []any:
		for i, field := range value {
			value[i] = safeValue("", field)
		}
	}
	return value
}

// ReplaceAttr applies the same secret policy to application and dependency records.
func ReplaceAttr(_ []string, attr slog.Attr) slog.Attr {
	attr.Value = attr.Value.Resolve()
	if privateField(attr.Key) {
		return slog.String(attr.Key, "[redacted]")
	}
	if attr.Value.Kind() == slog.KindString {
		return slog.Any(attr.Key, safeValue(attr.Key, attr.Value.String()))
	}
	if attr.Value.Kind() == slog.KindAny {
		if err, ok := attr.Value.Any().(error); ok {
			return slog.String(attr.Key, SafeText(err.Error()))
		}
		value := attr.Value.Any()
		// LiveKit's RTP/BWE wrappers expose Zap fields, not JSON-visible struct fields.
		switch object := value.(type) {
		case zapcore.ObjectMarshaler:
			encoder := zapcore.NewMapObjectEncoder()
			if err := object.MarshalLogObject(encoder); err != nil {
				return slog.String(attr.Key, "[diagnostic field failed: "+SafeText(err.Error())+"]")
			}
			value = encoder.Fields
		case zapcore.ArrayMarshaler:
			encoder := zapcore.NewMapObjectEncoder()
			if err := encoder.AddArray("items", object); err != nil {
				return slog.String(attr.Key, "[diagnostic field failed: "+SafeText(err.Error())+"]")
			}
			value = encoder.Fields["items"]
		}
		data, err := json.Marshal(value)
		if err != nil {
			return slog.String(attr.Key, "[diagnostic value unavailable]")
		}
		value = nil
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.UseNumber()
		if decoder.Decode(&value) == nil {
			return slog.Any(attr.Key, safeValue(attr.Key, value))
		}
	}
	return attr
}

// LineWriter turns dependency stderr into bounded records without writing on the TUI.
type LineWriter struct {
	mu         sync.Mutex
	logger     *slog.Logger
	line       []byte
	omitted    int
	privateKey bool
}

func Writer(scope string) *LineWriter {
	return &LineWriter{logger: slog.Default().With("library", scope)}
}

func (writer *LineWriter) Write(data []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	for _, char := range data {
		if char == '\n' {
			writer.flush()
		} else if len(writer.line) < maxLineBytes {
			writer.line = append(writer.line, char)
		} else {
			writer.omitted++
		}
	}
	return len(data), nil
}

func (writer *LineWriter) flush() {
	line := strings.TrimSuffix(string(writer.line), "\r")
	if strings.Contains(line, "-----BEGIN ") && strings.Contains(line, "PRIVATE KEY-----") {
		writer.privateKey = true
	}
	if writer.privateKey {
		writer.privateKey = !(strings.Contains(line, "-----END ") && strings.Contains(line, "PRIVATE KEY-----"))
		line = "[private key redacted]"
	}
	if line != "" || writer.omitted > 0 {
		writer.logger.Debug("dependency", "line", SafeText(line), "omittedBytes", writer.omitted)
	}
	writer.line = writer.line[:0]
	writer.omitted = 0
}

func (writer *LineWriter) Close() error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	writer.flush()
	return nil
}

func PionLoggerFactory(fields ...any) logging.LoggerFactory {
	factory := logging.NewDefaultLoggerFactory()
	// Dependency ICE detail belongs to opt-in diagnostics, including Pion's
	// error-level candidate observations. Never bypass redaction via stderr.
	writer := Writer("pion")
	writer.logger = writer.logger.With(fields...)
	factory.Writer = writer
	if slog.Default().Enabled(context.Background(), slog.LevelDebug) {
		factory.DefaultLogLevel = logging.LogLevelDebug
	}
	return factory
}

func MediaLogger(scope string) medialog.Logger {
	if !slog.Default().Enabled(context.Background(), slog.LevelDebug) {
		return medialog.GetDiscardLogger()
	}
	return medialog.LogRLogger(logr.FromSlogHandler(slog.Default().With("library", "livekit", "scope", scope).Handler()))
}
