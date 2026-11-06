// Package ordered provides an insertion-ordered map with live iteration.
// Wire-visible participant order, candidate ordering, round-robin state and
// deletion during iteration depend on those semantics.
package ordered

import "iter"

type entry[K comparable, V any] struct {
	key     K
	value   V
	deleted bool
}

// Map keeps keys in first-insertion order. Set on an existing key keeps its
// position; MoveToBack removes and reinserts it at the end. Iteration is live:
// an entry deleted before it is visited is skipped and an entry appended
// during iteration is visited.
// The zero value is ready to use.
type Map[K comparable, V any] struct {
	entries   []entry[K, V]
	index     map[K]int
	deleted   int
	iterating int
}

// Len reports the number of live entries.
func (m *Map[K, V]) Len() int { return len(m.index) }

// Get returns the value for key and whether it is present.
func (m *Map[K, V]) Get(key K) (V, bool) {
	if position, ok := m.index[key]; ok {
		return m.entries[position].value, true
	}
	var zero V
	return zero, false
}

// Has reports whether key is present.
func (m *Map[K, V]) Has(key K) bool {
	_, ok := m.index[key]
	return ok
}

// Set stores value under key, keeping the existing position when the key is
// already present and appending otherwise.
func (m *Map[K, V]) Set(key K, value V) {
	if position, ok := m.index[key]; ok {
		m.entries[position].value = value
		return
	}
	if m.index == nil {
		m.index = make(map[K]int)
	}
	m.index[key] = len(m.entries)
	m.entries = append(m.entries, entry[K, V]{key: key, value: value})
}

// MoveToBack re-inserts key at the end, as JavaScript `map.delete(k);
// map.set(k, v)` does. It is a plain Set when the key is absent.
func (m *Map[K, V]) MoveToBack(key K, value V) {
	m.Delete(key)
	m.Set(key, value)
}

// Delete removes key and reports whether it was present.
func (m *Map[K, V]) Delete(key K) bool {
	position, ok := m.index[key]
	if !ok {
		return false
	}
	delete(m.index, key)
	var zero V
	m.entries[position].value = zero
	m.entries[position].deleted = true
	m.deleted++
	m.compact()
	return true
}

// Clear removes every entry. Dropping the index before compacting is safe
// because every entry is now a tombstone, so compact writes no index entry.
func (m *Map[K, V]) Clear() {
	for position := range m.entries {
		if !m.entries[position].deleted {
			var zero V
			m.entries[position].value = zero
			m.entries[position].deleted = true
			m.deleted++
		}
	}
	m.index = nil
	m.compact()
}

// Keys returns a snapshot of the live keys in order.
func (m *Map[K, V]) Keys() []K {
	keys := make([]K, 0, len(m.index))
	for _, current := range m.entries {
		if !current.deleted {
			keys = append(keys, current.key)
		}
	}
	return keys
}

// Values returns a snapshot of the live values in order.
func (m *Map[K, V]) Values() []V {
	values := make([]V, 0, len(m.index))
	for _, current := range m.entries {
		if !current.deleted {
			values = append(values, current.value)
		}
	}
	return values
}

// All iterates live entries in order with JavaScript Map semantics. Mutating
// the map inside the loop is allowed.
func (m *Map[K, V]) All() iter.Seq2[K, V] {
	return func(yield func(K, V) bool) {
		m.iterating++
		defer func() {
			m.iterating--
			m.compact()
		}()
		for position := 0; position < len(m.entries); position++ {
			current := m.entries[position]
			if current.deleted {
				continue
			}
			if !yield(current.key, current.value) {
				return
			}
		}
	}
}

// compact drops tombstones once they dominate, but never while an iteration
// is walking the entry slice.
func (m *Map[K, V]) compact() {
	if m.iterating > 0 || m.deleted == 0 || m.deleted*2 < len(m.entries) {
		return
	}
	live := make([]entry[K, V], 0, len(m.index))
	for _, current := range m.entries {
		if !current.deleted {
			m.index[current.key] = len(live)
			live = append(live, current)
		}
	}
	m.entries = live
	m.deleted = 0
}
