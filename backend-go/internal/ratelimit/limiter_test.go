package ratelimit

import (
	"testing"
	"time"
)

func TestAllowUpToLimitThenBlock(t *testing.T) {
	l := New(3, time.Minute)

	for i := 0; i < 3; i++ {
		if res := l.Allow("k"); !res.Allowed {
			t.Fatalf("第 %d 次应放行", i+1)
		}
	}
	res := l.Allow("k")
	if res.Allowed {
		t.Fatal("第 4 次应被拦")
	}
	if res.RetryAfter <= 0 || res.RetryAfter > time.Minute {
		t.Fatalf("RetryAfter 不合理: %v", res.RetryAfter)
	}
}

func TestKeysAreIndependent(t *testing.T) {
	l := New(1, time.Minute)
	if !l.Allow("a").Allowed {
		t.Fatal("a 首次应放行")
	}
	if l.Allow("a").Allowed {
		t.Fatal("a 第二次应被拦")
	}
	// 不同 key 不能互相影响：改密限流按用户维度，误伤等于把别人锁在门外
	if !l.Allow("b").Allowed {
		t.Fatal("b 首次应放行")
	}
}

func TestResetClearsCounter(t *testing.T) {
	l := New(1, time.Minute)
	l.Allow("k")
	if l.Allow("k").Allowed {
		t.Fatal("第二次应被拦")
	}
	l.Reset("k")
	if !l.Allow("k").Allowed {
		t.Fatal("Reset 后应重新放行")
	}
}

func TestWindowExpiry(t *testing.T) {
	l := New(1, 60*time.Millisecond)
	if !l.Allow("k").Allowed {
		t.Fatal("首次应放行")
	}
	if l.Allow("k").Allowed {
		t.Fatal("窗口内第二次应被拦")
	}
	time.Sleep(80 * time.Millisecond)
	if !l.Allow("k").Allowed {
		t.Fatal("窗口过期后应重新放行")
	}
}
