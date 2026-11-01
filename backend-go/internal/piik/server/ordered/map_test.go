package ordered

import (
	"slices"
	"testing"
)

func TestMapKeepsInsertionOrderAndPositionOnSet(t *testing.T) {
	var m Map[string, int]
	m.Set("a", 1)
	m.Set("b", 2)
	m.Set("c", 3)
	m.Set("a", 10)
	if got := m.Keys(); !slices.Equal(got, []string{"a", "b", "c"}) {
		t.Fatalf("keys = %v", got)
	}
	if got := m.Values(); !slices.Equal(got, []int{10, 2, 3}) {
		t.Fatalf("values = %v", got)
	}
	m.MoveToBack("a", 11)
	if got := m.Keys(); !slices.Equal(got, []string{"b", "c", "a"}) {
		t.Fatalf("keys after MoveToBack = %v", got)
	}
	if value, ok := m.Get("a"); !ok || value != 11 || m.Len() != 3 {
		t.Fatalf("get a = %v %v len %d", value, ok, m.Len())
	}
}

func TestMapLiveIterationSkipsDeletedAndVisitsAppended(t *testing.T) {
	var m Map[string, int]
	for _, key := range []string{"a", "b", "c", "d"} {
		m.Set(key, len(key))
	}
	var visited []string
	for key := range m.All() {
		visited = append(visited, key)
		switch key {
		case "a":
			m.Delete("c") // deleted before its turn: skipped, like a JS Map
		case "b":
			m.Set("e", 1) // appended during iteration: visited
		}
	}
	if !slices.Equal(visited, []string{"a", "b", "d", "e"}) {
		t.Fatalf("visited = %v", visited)
	}
	if got := m.Keys(); !slices.Equal(got, []string{"a", "b", "d", "e"}) {
		t.Fatalf("keys = %v", got)
	}
}

func TestMapCompactionPreservesOrderAndIndex(t *testing.T) {
	var m Map[int, int]
	for index := 0; index < 100; index++ {
		m.Set(index, index)
	}
	for index := 0; index < 100; index += 2 {
		m.Delete(index)
	}
	if m.Len() != 50 || len(m.entries) > 60 {
		t.Fatalf("len %d entries %d", m.Len(), len(m.entries))
	}
	for index := 1; index < 100; index += 2 {
		if value, ok := m.Get(index); !ok || value != index {
			t.Fatalf("get %d = %v %v", index, value, ok)
		}
	}
	keys := m.Keys()
	if keys[0] != 1 || keys[49] != 99 || !slices.IsSorted(keys) {
		t.Fatalf("keys = %v", keys)
	}
	if m.Delete(1000) {
		t.Fatal("deleting an absent key must report false")
	}
	m.Clear()
	if m.Len() != 0 || len(m.Keys()) != 0 {
		t.Fatal("clear must empty the map")
	}
}
