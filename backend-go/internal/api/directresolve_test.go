package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"

	"zviewer/backend/internal/config"
	dbutil "zviewer/backend/internal/db"
	"zviewer/backend/internal/openlist"
	"zviewer/backend/internal/store"
)

func strPtr(v string) *string { return &v }

func TestExtractDirectTarget(t *testing.T) {
	base := func() *store.Movie {
		return &store.Movie{
			Source:     strPtr("openlist"),
			ServerURL:  strPtr("http://nas:5244"),
			Path:       strPtr("/movies/a.mkv"),
			DirectLink: true,
		}
	}

	target, ok := extractDirectTarget(base())
	if !ok {
		t.Fatal("合法直链影片应可解析")
	}
	// openlist 的 serverUrl 必须先规范化（补 /dav）再匹配挂载表，
	// 否则挂载里存的规范化地址永远匹配不上。
	if target.ServerURL != "http://nas:5244/dav" {
		t.Fatalf("openlist serverUrl 未规范化: %q", target.ServerURL)
	}
	if target.Kind != "openlist" || target.Path != "/movies/a.mkv" {
		t.Fatalf("解析结果不符: %+v", target)
	}

	// webdav 不做规范化（原样使用）
	webdavMovie := base()
	webdavMovie.Source = strPtr("webdav")
	webdavMovie.ServerURL = strPtr("https://dav.example.com")
	if target, ok := extractDirectTarget(webdavMovie); !ok || target.ServerURL != "https://dav.example.com" {
		t.Fatalf("webdav 不应改写 serverUrl: %+v, %v", target, ok)
	}

	cases := map[string]func(*store.Movie){
		"非直链影片":        func(m *store.Movie) { m.DirectLink = false },
		"非 openlist":   func(m *store.Movie) { m.Source = strPtr("emby") },
		"source 为 nil": func(m *store.Movie) { m.Source = nil },
		"缺 serverUrl":  func(m *store.Movie) { m.ServerURL = nil },
		"缺 path":       func(m *store.Movie) { m.Path = nil },
		"serverUrl 空串": func(m *store.Movie) { m.ServerURL = strPtr("  ") },
		"path 空串":      func(m *store.Movie) { m.Path = strPtr("") },
	}
	for name, mutate := range cases {
		m := base()
		mutate(m)
		if _, ok := extractDirectTarget(m); ok {
			t.Fatalf("%s 不应被当作可解析直链影片", name)
		}
	}
}

func TestDirectResolveTargetCacheKey(t *testing.T) {
	a := directResolveTarget{Kind: "openlist", ServerURL: "http://nas/dav", Path: "/a.mkv"}
	b := directResolveTarget{Kind: "openlist", ServerURL: "http://nas/dav", Path: "/a.mkv"}
	c := directResolveTarget{Kind: "webdav", ServerURL: "http://nas/dav", Path: "/a.mkv"}
	access := directResolveAccess{}
	if access.cacheKey(a) != access.cacheKey(b) {
		t.Fatal("相同目标应命中同一缓存键")
	}
	if access.cacheKey(a) == access.cacheKey(c) {
		t.Fatal("不同类型必须区分缓存键（openlist 与 webdav 走不同解析分支）")
	}
}

type directResolveTransport func(*http.Request) (*http.Response, error)

func (f directResolveTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func directResolveTestServer(transport directResolveTransport) *Server {
	client := openlist.NewClient()
	client.HTTP.Transport = transport
	return New(Deps{Cfg: &config.Config{}, OpenList: client})
}

func directResolveTestMovie() *store.Movie {
	return &store.Movie{ID: 1, Source: strPtr("openlist"), DirectLink: true,
		ServerURL: strPtr("https://files.example.invalid/dav"), Path: strPtr("/movie.mp4")}
}

func TestDirectResolveConcurrentWaiters(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "upstream error"}[fail], func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				release := make(chan struct{})
				var requests atomic.Int32
				s := directResolveTestServer(func(r *http.Request) (*http.Response, error) {
					requests.Add(1)
					<-release
					body := `{"code":200,"data":{"raw_url":"https://cdn.example.invalid/movie.mp4"}}`
					if fail {
						body = `{"code":404,"message":"object not found"}`
					}
					status := http.StatusOK
					if fail {
						status = http.StatusNotFound
					}
					return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
				})
				const count = 12
				results := make(chan directResolveResult, count)
				for range count {
					go func() {
						url, err := s.resolveMovieDirectURL(context.Background(), directResolveTestMovie())
						results <- directResolveResult{url: url, err: err}
					}()
				}
				synctest.Wait() // All callers are blocked behind the same upstream request.
				close(release)
				synctest.Wait()
				for range count {
					result := <-results
					if fail {
						if result.err == nil || result.err.Code != "NOT_FOUND" {
							t.Errorf("every waiter must receive the upstream error: %+v", result)
						}
					} else if result.err != nil || result.url != "https://cdn.example.invalid/movie.mp4" {
						t.Errorf("every waiter must receive the resolved URL: %+v", result)
					}
				}
				if requests.Load() != 1 {
					t.Errorf("upstream requests = %d, want 1", requests.Load())
				}
			})
		})
	}
}

func TestDirectResolveWaiterCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		s := directResolveTestServer(func(r *http.Request) (*http.Response, error) {
			<-release
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(
				`{"code":200,"data":{"raw_url":"https://cdn.example.invalid/movie.mp4"}}`)), Header: make(http.Header)}, nil
		})
		go func() { _, _ = s.resolveMovieDirectURL(context.Background(), directResolveTestMovie()) }()
		synctest.Wait()
		ctx, cancel := context.WithCancel(context.Background())
		finished := make(chan *directResolveError, 1)
		go func() { _, err := s.resolveMovieDirectURL(ctx, directResolveTestMovie()); finished <- err }()
		synctest.Wait()
		cancel()
		synctest.Wait()
		select {
		case err := <-finished:
			if err == nil {
				t.Error("canceled waiter returned success")
			}
		default:
			t.Error("canceled waiter still blocked behind upstream request")
		}
		close(release)
		synctest.Wait()
	})
}

func TestDirectResolveCredentialIsolation(t *testing.T) {
	s := directResolveTestServer(func(r *http.Request) (*http.Response, error) {
		data := map[string]any{}
		if strings.HasPrefix(r.URL.Path, "/api/auth/login") {
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			data["token"] = body["username"] + "-" + body["password"]
		} else {
			data["raw_url"] = "https://cdn.example.invalid/" + r.Header.Get("Authorization") + "/movie.mp4"
		}
		body, _ := json.Marshal(map[string]any{"code": 200, "data": data})
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})
	conn, err := dbutil.OpenForInit(t.TempDir()+"/test.sqlite", true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if err := dbutil.InitSchema(context.Background(), conn); err != nil {
		t.Fatal(err)
	}
	s.Mounts, s.Rooms = store.NewMounts(conn), store.NewRooms(conn)
	for _, owner := range []int{1, 2} {
		if _, err := conn.Exec(`INSERT INTO "room" ("roomId", "ownerUserId") VALUES (?,?)`,
			map[int]string{1: "room-a", 2: "room-b"}[owner], owner); err != nil {
			t.Fatal(err)
		}
	}
	var mounts []*store.Mount
	for i, name := range []string{"alice", "bob"} {
		mount, err := s.Mounts.Create(context.Background(), store.MountInput{
			UserID: int64(i + 1), Type: "openlist", Name: name,
			ServerURL: strPtr("https://files.example.invalid/dav"), Username: strPtr(name), Password: strPtr("fixture"),
		})
		if err != nil {
			t.Fatal(err)
		}
		mounts = append(mounts, mount)
	}
	resolve := func(movie *store.Movie, want string) {
		t.Helper()
		got, err := s.resolveMovieDirectURL(context.Background(), movie)
		if err != nil || got != "https://cdn.example.invalid/"+want+"/movie.mp4" {
			t.Errorf("direct URL used the wrong credentials: got %q, error %v, want identity %s", got, err, want)
		}
	}
	// The same URL/path can name different content for different upstream users.
	a, b := directResolveTestMovie(), directResolveTestMovie()
	a.RoomID, a.SourceMountID = "room-a", &mounts[0].ID
	b.ID, b.RoomID, b.SourceMountID = 2, "room-b", &mounts[1].ID
	resolve(a, "alice-fixture")
	resolve(b, "bob-fixture")
	// Historical records have no sourceMountId; only the room owner's mount is valid.
	b.SourceMountID = nil
	resolve(b, "bob-fixture")
	// Explicit movie credentials take precedence over a mount's defaults.
	b.Username, b.Password = strPtr("carol"), strPtr("movie-fixture")
	resolve(b, "carol-movie-fixture")
	b.Password = strPtr("updated-fixture")
	resolve(b, "carol-updated-fixture")
	// An unrelated user's mount must never become the fallback for this room.
	if _, err := conn.Exec(`DELETE FROM "user_mount" WHERE "userId" = 2`); err != nil {
		t.Fatal(err)
	}
	b.Username, b.Password = nil, nil
	resolve(b, "")
}
