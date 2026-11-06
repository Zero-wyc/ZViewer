package signal

import (
	"reflect"
	"sort"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/route"
	"zviewer/backend/internal/piik/server/sfu"
)

func (s *Server) syncRoomVoice(roomID string) {
	v := s.voices[roomID]
	if v == nil {
		return
	}
	v.revision++
	s.voiceRoom(roomID)
	for peerID, m := range v.members {
		if sess, _ := s.voiceSession(roomID, peerID); sess == nil {
			m.publicationID = ""
		}
	}
	pubs := make([]protocol.VoicePublication, 0, len(v.members))
	for peerID, m := range v.members {
		if m.publicationID != "" && s.voiceAllowed(roomID, peerID) {
			pubs = append(pubs, protocol.VoicePublication{ID: m.publicationID, PeerID: peerID})
		}
	}
	sort.Slice(pubs, func(i, j int) bool { return pubs[i].ID < pubs[j].ID })
	edges := s.roomVoiceEdges(roomID, v)
	for _, edge := range v.connections {
		if _, keep := edges[edge.logicalID]; !keep {
			s.closeVoiceEdge(roomID, edge)
		}
	}
	v.connections = edges
	unavailable := s.projectVoiceFlows(roomID, v, pubs)
	for _, edge := range edges {
		if edge.transport == "sfu" {
			s.configureVoiceJunction(roomID, v, edge, pubs)
		}
	}
	members := make([]protocol.VoiceMember, 0, len(v.members))
	ids := make([]string, 0, len(v.members))
	for peerID := range v.members {
		ids = append(ids, peerID)
	}
	sort.Strings(ids)
	for _, peerID := range ids {
		m := v.members[peerID]
		sess, _ := s.voiceSession(roomID, peerID)
		upstream := protocol.NoUpstream()
		for _, edge := range edges {
			if edge.child == peerID && !edge.pending && edge.connected[edge.child] && edge.connected[edge.parent] {
				upstream = protocol.SfuUpstream()
				if edge.transport == "peer" {
					upstream = protocol.PeerUpstream(edge.parent)
				}
				break
			}
		}
		members = append(members, protocol.VoiceMember{PeerID: peerID, Connected: sess != nil,
			Joined: m.joined, Upstream: upstream, PublicationID: m.publicationID})
	}
	var hostID *string
	if v.hostPeerID != "" {
		hostID = &v.hostPeerID
	}
	for _, peerID := range ids {
		sess, _ := s.voiceSession(roomID, peerID)
		if sess == nil {
			continue
		}
		recipientMembers := members
		if sess.roomVoiceListeningPresence {
			recipientMembers = append([]protocol.VoiceMember(nil), members...)
			for i := range recipientMembers {
				member := &recipientMembers[i]
				if member.Connected {
					member.Deafened = v.members[member.PeerID].deafened
				}
			}
		}
		connections := []protocol.VoiceConnection{}
		for _, edge := range edges {
			if peerID != edge.parent && peerID != edge.child {
				continue
			}
			other := edge.parent
			if peerID == edge.parent {
				other = edge.child
			}
			connections = append(connections, protocol.VoiceConnection{ConnectionID: edge.id,
				ParentPeerID: edge.parent, ChildPeerID: edge.child, Transport: edge.transport,
				Pending: edge.pending, Revision: protocol.Int(edge.revision),
				Send: append([]string{}, edge.send[peerID]...), Receive: append([]string{}, edge.send[other]...)})
		}
		sort.Slice(connections, func(i, j int) bool { return connections[i].ConnectionID < connections[j].ConnectionID })
		bitrate := protocol.Int(0)
		if sess.roomVoiceBitrate {
			bitrate = v.bitrate
		}
		s.send(sess, protocol.RoomVoiceStateMessage{Type: "room-voice-state", Bitrate: bitrate, Revision: protocol.Int(v.revision), Enabled: v.enabled(),
			HostPeerID: hostID, Members: recipientMembers, Publications: pubs, Connections: connections,
			Unavailable: append([]string{}, unavailable[peerID]...)})
	}
}

func (s *Server) roomVoiceEdges(roomID string, v *roomVoice) map[string]*voiceEdge {
	next := make(map[string]*voiceEdge)
	rm, _ := s.router.rooms.Get(roomID)
	if rm == nil || rm.controller == nil || !rm.roomMedia {
		return next
	}
	snapshot := rm.controller.Snapshot()
	add := func(logical, parent, child, transport string, pending bool, revision int64) {
		if !s.voiceAllowed(roomID, child) || parent != "" && !s.voiceAllowed(roomID, parent) {
			return
		}
		childSession, _ := s.voiceSession(roomID, child)
		parentID := ""
		if parent != "" {
			parentSession, _ := s.voiceSession(roomID, parent)
			parentID = parentSession.sessionID
		}
		edge := v.connections[logical]
		if edge != nil && (edge.parentSession != parentID || edge.childSession != childSession.sessionID) {
			s.closeVoiceEdge(roomID, edge)
			edge = nil
		}
		if edge == nil {
			edge = &voiceEdge{id: opaqueID(), logicalID: logical, parent: parent, child: child,
				transport: transport, parentSession: parentID, childSession: childSession.sessionID, connected: make(map[string]bool)}
		}
		edge.pending, edge.revision = pending, revision
		edge.send = map[string][]string{parent: {}, child: {}}
		next[logical] = edge
	}
	if publication := snapshot.HostPublication; publication != nil && publication.PhysicalActive {
		add(publication.Generation, "", rm.hostPeerID, "sfu", false, snapshot.Revision)
	}
	for child, edge := range snapshot.UpstreamByViewer.All() {
		if !edge.PhysicalActive {
			continue
		}
		parent, transport := edge.ParentPeerID, "peer"
		if edge.Kind == route.UpstreamSfu {
			parent, transport = "", "sfu"
		}
		add(edge.ConnectionID, parent, child, transport, false, snapshot.Revision)
	}
	if op := snapshot.Operation; op != nil && op.Current != nil && op.AttachConnectionID == "" {
		parent, transport := op.Current.Tuple.ParentPeerID, "peer"
		if op.Current.Tuple.Kind == route.UpstreamSfu {
			parent, transport = "", "sfu"
			if prepared := rm.pendingMedia; prepared != nil && prepared.connectionID == op.Current.ConnectionID &&
				prepared.publicationConnectionID != "" {
				add(prepared.publicationGeneration, "", rm.hostPeerID, "sfu", true, op.Current.Revision)
			}
		}
		add(op.Current.ConnectionID, parent, op.ChildPeerID, transport, true, op.Current.Revision)
	}
	return next
}

// Every publication takes the unique path in the committed room tree. A relay
// outside voice is not a permissible decoded-audio hop.
func (s *Server) projectVoiceFlows(roomID string, v *roomVoice, pubs []protocol.VoicePublication) map[string][]string {
	type hop struct {
		from, to string
		edge     *voiceEdge
	}
	adjacent := make(map[string][]hop)
	for _, edge := range v.connections {
		if edge.pending {
			continue
		}
		adjacent[edge.parent] = append(adjacent[edge.parent], hop{edge.parent, edge.child, edge})
		adjacent[edge.child] = append(adjacent[edge.child], hop{edge.child, edge.parent, edge})
	}
	unavailable := make(map[string][]string)
	for _, pub := range pubs {
		paths := map[string][]hop{pub.PeerID: {}}
		queue := []string{pub.PeerID}
		for len(queue) > 0 {
			from := queue[0]
			queue = queue[1:]
			for _, step := range adjacent[from] {
				if _, seen := paths[step.to]; seen {
					continue
				}
				paths[step.to] = append(append([]hop{}, paths[from]...), step)
				queue = append(queue, step.to)
			}
		}
		used := make(map[string]bool)
		for peerID := range v.members {
			if peerID == pub.PeerID || !s.voiceAllowed(roomID, peerID) {
				continue
			}
			path, found := paths[peerID]
			if !found {
				unavailable[peerID] = append(unavailable[peerID], pub.ID)
				continue
			}
			for _, step := range path {
				if !used[step.edge.id] {
					step.edge.send[step.from] = append(step.edge.send[step.from], pub.ID)
					used[step.edge.id] = true
				}
			}
		}
	}
	return unavailable
}

func (s *Server) voiceRuntime() sfu.VoiceRuntime {
	if s.sfuFallback == nil {
		return nil
	}
	runtime, _ := s.sfuFallback.Media.(sfu.VoiceRuntime)
	return runtime
}

func (s *Server) configureVoiceJunction(roomID string, v *roomVoice, edge *voiceEdge, pubs []protocol.VoicePublication) {
	runtime := s.voiceRuntime()
	if runtime == nil {
		return
	}
	plan := sfu.VoiceConnectionPlan{RoomID: roomID, PeerID: edge.child, SessionID: edge.childSession, ConnectionID: edge.id,
		Publish: []sfu.VoicePublication{}, Subscribe: []sfu.VoicePublication{}}
	for _, pub := range pubs {
		item := sfu.VoicePublication{ID: pub.ID, PeerID: pub.PeerID}
		for _, id := range edge.send[edge.child] {
			if id == pub.ID {
				plan.Publish = append(plan.Publish, item)
			}
		}
		for _, id := range edge.send[""] {
			if id == pub.ID {
				plan.Subscribe = append(plan.Subscribe, item)
			}
		}
	}
	if edge.sfuPlan != nil && reflect.DeepEqual(*edge.sfuPlan, plan) {
		return
	}
	edge.sfuPlan = &plan
	work, err := runtime.ConfigureVoice(plan, s.onVoiceMediaEvent)
	if err != nil {
		s.failVoicePlan(roomID, edge)
		return
	}
	if edge.sfuWork != nil {
		edge.sfuWork.run = work
		return
	}
	if work != nil {
		operation := &voiceNegotiation{run: work, done: make(chan struct{})}
		edge.sfuWork = operation
		s.router.inflight++
		go s.negotiateVoice(roomID, v, edge, operation)
	}
}

// The synchronous graph hook only commits intent. One worker per physical edge
// coalesces changes into the latest plan without yielding its caller's lock.
func (s *Server) negotiateVoice(roomID string, v *roomVoice, edge *voiceEdge, operation *voiceNegotiation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	defer func() {
		edge.sfuWork = nil
		s.router.inflight--
		close(operation.done)
	}()
	for !s.closing && s.voices[roomID] == v && v.connections[edge.logicalID] == edge && edge.sfuPlan != nil && operation.run != nil {
		plan, run := edge.sfuPlan, operation.run
		var err error
		s.router.io(func() { err = run() })
		if s.voices[roomID] != v || v.connections[edge.logicalID] != edge {
			return
		}
		if edge.sfuPlan != plan {
			continue
		}
		if err != nil {
			s.failVoicePlan(roomID, edge)
		}
		return
	}
}

func (s *Server) failVoicePlan(roomID string, edge *voiceEdge) {
	edge.sfuPlan = nil
	if sess, _ := s.voiceSession(roomID, edge.child); sess != nil && sess.sessionID == edge.childSession {
		s.voiceError(sess, "connection-unavailable")
	}
}

func (s *Server) closeVoiceEdge(roomID string, edge *voiceEdge) {
	if edge.transport == "sfu" {
		if runtime := s.voiceRuntime(); runtime != nil {
			closePhysical := runtime.CloseVoice(roomID, edge.child, edge.childSession, edge.id)
			if operation := edge.sfuWork; operation != nil {
				closeTransport := closePhysical
				closePhysical = func() error {
					var err error
					if closeTransport != nil {
						err = closeTransport()
					}
					<-operation.done
					return err
				}
			}
			if closePhysical != nil {
				key := sfu.SubscriptionFence{ResourceFence: sfu.ResourceFence{RoomID: roomID, PublicationGeneration: edge.id}, ConnectionID: edge.id}
				task := &sfuDrainTask{kind: drainVoice, fence: key, closePhysical: closePhysical}
				s.router.sfuDrainTasks.Set(key, task)
				s.router.runSfuDrain(key, task)
			}
		}
	}
}
