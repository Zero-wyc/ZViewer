package share

import (
	"errors"
	"strings"
	"testing"
)

func TestSessionStartMintsGeneration(t *testing.T) {
	session := newSession("r")
	before := session.Revision()

	snapshot, err := session.Start(nil, false, &QualitySettings{ResolutionPreset: "1080p", FrameRate: 30, MaxBitrateMbps: 8})
	if err != nil {
		t.Fatalf("Start 失败: %v", err)
	}
	if !snapshot.Sharing {
		t.Fatal("開始后 sharing 应为 true")
	}
	if !strings.HasPrefix(snapshot.ShareGeneration, "share_") {
		t.Fatalf("代际前缀不对: %q", snapshot.ShareGeneration)
	}
	if snapshot.Revision <= before {
		t.Fatalf("revision 应推进: %d -> %d", before, snapshot.Revision)
	}
	if snapshot.QualitySettings.ResolutionPreset != "1080p" {
		t.Fatalf("档位未保存: %+v", snapshot.QualitySettings)
	}
}

// 房主刷新后带上一代际重连：必须沿用同一代，否则所有观众刚建立的连接会被判过期。
func TestSessionStartWithMatchingHintKeepsGeneration(t *testing.T) {
	session := newSession("r")
	first, _ := session.Start(nil, false, nil)

	hint := first.ShareGeneration
	second, err := session.Start(&hint, true, &QualitySettings{ResolutionPreset: "720p"})
	if err != nil {
		t.Fatalf("带匹配代际的 Start 应成功: %v", err)
	}
	if second.ShareGeneration != first.ShareGeneration {
		t.Fatalf("代际被替换: %q -> %q", first.ShareGeneration, second.ShareGeneration)
	}
	if !second.Paused {
		t.Fatal("暂停态应被同步")
	}
	if second.QualitySettings.ResolutionPreset != "720p" {
		t.Fatalf("档位应被更新: %+v", second.QualitySettings)
	}
}

// 共享进行中再发一次 start（没有代际）= 房主重复点开始，不替换也不断连。
func TestSessionStartTwiceWithoutHintFails(t *testing.T) {
	session := newSession("r")
	if _, err := session.Start(nil, false, nil); err != nil {
		t.Fatalf("首次 Start 失败: %v", err)
	}
	if _, err := session.Start(nil, false, nil); !errors.Is(err, ErrAlreadySharing) {
		t.Fatalf("期望 ErrAlreadySharing，实际 %v", err)
	}
	if !session.Snapshot().Sharing {
		t.Fatal("失败不应结束已有的共享")
	}
}

func TestSessionStartAfterStopMintsNewGeneration(t *testing.T) {
	session := newSession("r")
	first, _ := session.Start(nil, false, nil)
	if _, err := session.Stop(first.ShareGeneration); err != nil {
		t.Fatalf("Stop 失败: %v", err)
	}
	second, err := session.Start(nil, false, nil)
	if err != nil {
		t.Fatalf("Stop 后 Start 应成功: %v", err)
	}
	if second.ShareGeneration == first.ShareGeneration {
		t.Fatal("停掉再开必须换新代际，否则旧观众手里的代际会一直有效")
	}
	if second.ShareGeneration == "" {
		t.Fatal("新代际不能为空")
	}
}

func TestSessionStopRejectsStaleGeneration(t *testing.T) {
	session := newSession("r")
	if _, err := session.Start(nil, false, nil); err != nil {
		t.Fatalf("Start 失败: %v", err)
	}
	if _, err := session.Stop("share_stale"); !errors.Is(err, ErrGenerationReplaced) {
		t.Fatalf("期望 ErrGenerationReplaced，实际 %v", err)
	}
}

func TestSessionStopWithoutSharing(t *testing.T) {
	session := newSession("r")
	if _, err := session.Stop("share_anything"); !errors.Is(err, ErrNotSharing) {
		t.Fatalf("期望 ErrNotSharing，实际 %v", err)
	}
}

func TestSessionPauseRequiresMatchingGeneration(t *testing.T) {
	session := newSession("r")
	started, _ := session.Start(nil, false, nil)

	if _, err := session.SetPaused("share_stale", true); !errors.Is(err, ErrGenerationReplaced) {
		t.Fatalf("过期代际应被拒: %v", err)
	}
	snapshot, err := session.SetPaused(started.ShareGeneration, true)
	if err != nil {
		t.Fatalf("暂停失败: %v", err)
	}
	if !snapshot.Paused {
		t.Fatal("paused 未生效")
	}
}

// 同值重复设置不推进 revision：否则前端会被无意义的新版本号推着重建。
func TestSessionPauseIsIdempotent(t *testing.T) {
	session := newSession("r")
	started, _ := session.Start(nil, false, nil)
	first, _ := session.SetPaused(started.ShareGeneration, true)
	second, err := session.SetPaused(started.ShareGeneration, true)
	if err != nil {
		t.Fatalf("重复暂停失败: %v", err)
	}
	if second.Revision != first.Revision {
		t.Fatalf("同值暂停不应推进 revision: %d -> %d", first.Revision, second.Revision)
	}
}

func TestSessionJoinIsIdempotent(t *testing.T) {
	session := newSession("r")
	first := session.Join("s1", "阿零", false)
	second := session.Join("s1", "阿零", false)
	if second.Revision != first.Revision {
		t.Fatalf("重复 hello 不应推进 revision: %d -> %d", first.Revision, second.Revision)
	}
	if len(second.Participants) != 1 {
		t.Fatalf("参与者应只有 1 个: %+v", second.Participants)
	}
}

func TestSessionJoinOrdersHostFirst(t *testing.T) {
	session := newSession("r")
	session.Join("v1", "观众甲", false)
	session.Join("v2", "观众乙", false)
	snapshot := session.Join("h1", "房主", true)
	if len(snapshot.Participants) != 3 {
		t.Fatalf("参与者数量错误: %d", len(snapshot.Participants))
	}
	if snapshot.Participants[0].Role != RoleHost {
		t.Fatalf("房主应排在第一位: %+v", snapshot.Participants)
	}
	if snapshot.Participants[0].PeerID != "h1" {
		t.Fatalf("房主 peerId 错误: %q", snapshot.Participants[0].PeerID)
	}
}

func TestSessionLeave(t *testing.T) {
	session := newSession("r")
	session.Join("s1", "", false)
	snapshot, remaining := session.Leave("s1")
	if remaining {
		t.Fatal("最后一个参与者离开后应返回 remaining=false")
	}
	if len(snapshot.Participants) != 0 {
		t.Fatalf("快照应已清空: %+v", snapshot.Participants)
	}
	// 离开不存在的连接：不推进 revision，也不报错。
	again, _ := session.Leave("s404")
	if again.Revision != snapshot.Revision {
		t.Fatal("移除不存在的参与者不应推进 revision")
	}
}

// 快照必须是拷贝：调用方改它会污染会话的话，前端渲染逻辑会随机读到别人的改动。
func TestSessionSnapshotIsIsolated(t *testing.T) {
	session := newSession("r")
	session.Join("s1", "甲", false)
	first := session.Snapshot()
	first.Participants[0].DisplayName = "被改了"
	first.Participants = append(first.Participants, Participant{PeerID: "ghost"})

	second := session.Snapshot()
	if len(second.Participants) != 1 {
		t.Fatalf("快照共享了底层数组: %+v", second.Participants)
	}
	if second.Participants[0].DisplayName != "甲" {
		t.Fatalf("快照共享了结构体内存: %+v", second.Participants[0])
	}
}

func TestSessionMarkMediaReady(t *testing.T) {
	session := newSession("r")
	session.Join("s1", "", false)
	snapshot := session.MarkMediaReady("s1", true)
	if len(snapshot.Participants) != 1 || !snapshot.Participants[0].MediaReady {
		t.Fatalf("mediaReady 未置位: %+v", snapshot.Participants)
	}
	// 同值重复标记不推进 revision。
	again := session.MarkMediaReady("s1", true)
	if again.Revision != snapshot.Revision {
		t.Fatal("同值标记不应推进 revision")
	}
	// 不存在的参与者：忽略。
	missing := session.MarkMediaReady("s404", true)
	if missing.Revision != snapshot.Revision {
		t.Fatal("未知参与者不应推进 revision")
	}
}
