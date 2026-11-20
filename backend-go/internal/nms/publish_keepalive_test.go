package nms

import (
	"context"
	"testing"
)

// 未设置续期校验时必须回落到「能否开始推流」的校验（旧行为）。
func TestPublishKeepAliveFallsBackToPublishAllowed(t *testing.T) {
	s := New(Config{})
	s.SetAuthorizers(func(_ context.Context, key string) bool { return key == "ok" }, nil)

	if !s.publishKeepAlive(context.Background(), "ok") {
		t.Fatal("fallback should allow authorized key")
	}
	if s.publishKeepAlive(context.Background(), "nope") {
		t.Fatal("fallback should reject unauthorized key")
	}
}

// 显式设置续期校验后，看门狗改用放宽后的判定。
func TestPublishKeepAliveUsesCustomCheck(t *testing.T) {
	s := New(Config{})
	s.SetAuthorizers(func(_ context.Context, key string) bool { return key == "ok" }, nil)
	s.SetPublishKeepAlive(func(_ context.Context, key string) bool { return key == "keep" })

	if !s.publishKeepAlive(context.Background(), "keep") {
		t.Fatal("custom keep-alive should allow keep")
	}
	if s.publishKeepAlive(context.Background(), "ok") {
		t.Fatal("custom keep-alive should not fall back to publishAllowed")
	}
}
