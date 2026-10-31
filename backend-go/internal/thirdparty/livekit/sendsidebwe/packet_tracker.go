// Copyright 2023 LiveKit, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Modified by Piik: apply overlapping feedback once while retaining late ACKs.
// Keep delay measurement monotonic without discarding packet/loss accounting.
package sendsidebwe

import (
	"math/rand"
	"sync"

	"github.com/livekit/livekit-server/pkg/sfu/ccutils"
	"github.com/livekit/protocol/logger"
	"github.com/livekit/protocol/utils/mono"
)

// -------------------------------------------------------------------------------

const packetHistorySize = 2048

type packetTrackerParams struct {
	Logger logger.Logger
}

type packetTracker struct {
	params packetTrackerParams

	lock sync.Mutex

	sequenceNumber uint64

	baseSendTime int64
	packetInfos  [packetHistorySize]packetInfo

	baseRecvTime int64
	piLastRecv   *packetInfo
	lastRecvTime int64

	probeClusterId         ccutils.ProbeClusterId
	probeMaxSequenceNumber uint64
}

func newPacketTracker(params packetTrackerParams) *packetTracker {
	return &packetTracker{
		params:         params,
		sequenceNumber: uint64(rand.Intn(1<<14)) + uint64(1<<15), // a random number in third quartile of sequence number space
	}
}

func (p *packetTracker) ResetDelay() {
	p.lock.Lock()
	defer p.lock.Unlock()

	// Keep delivery history so overlapping reports cannot count packets twice.
	p.piLastRecv = nil
	p.lastRecvTime = 0
}

func (p *packetTracker) RecordPacketSendAndGetSequenceNumber(
	atMicro int64,
	size int,
	isRTX bool,
	probeClusterId ccutils.ProbeClusterId,
	isProbe bool,
) uint16 {
	p.lock.Lock()
	defer p.lock.Unlock()

	if p.baseSendTime == 0 {
		p.baseSendTime = atMicro
	}

	pi := p.getPacketInfo(uint16(p.sequenceNumber))
	*pi = packetInfo{
		sequenceNumber: p.sequenceNumber,
		sendTime:       atMicro - p.baseSendTime,
		size:           uint16(size),
		isRTX:          isRTX,
		probeClusterId: probeClusterId,
		isProbe:        isProbe,
	}

	p.sequenceNumber++

	// extreme case of wrap around before receiving any feedback
	if pi == p.piLastRecv {
		p.piLastRecv = nil
	}

	if p.probeClusterId != ccutils.ProbeClusterIdInvalid && p.probeClusterId == pi.probeClusterId && pi.sequenceNumber > p.probeMaxSequenceNumber {
		p.probeMaxSequenceNumber = pi.sequenceNumber
	}

	return uint16(pi.sequenceNumber)
}

func (p *packetTracker) BaseSendTimeThreshold(threshold int64) (int64, bool) {
	p.lock.Lock()
	defer p.lock.Unlock()

	if p.baseSendTime == 0 {
		return 0, false
	}

	return mono.UnixMicro() - p.baseSendTime - threshold, true
}

func (p *packetTracker) RecordPacketIndicationFromRemote(sn uint16, recvTime int64) (piRecv packetInfo, sendDelta, recvDelta int64) {
	p.lock.Lock()
	defer p.lock.Unlock()

	pi := p.getPacketInfoExisting(sn)
	if pi == nil {
		return
	}

	// Reports may overlap after reordering. Only new observations may change
	// counters or the delta baseline; a late ACK must still repair earlier loss.
	if pi.feedback == packetFeedbackReceived || pi.feedback == packetFeedbackReceivedAfterLoss {
		return
	}
	if recvTime == 0 {
		if pi.feedback == packetFeedbackLost {
			return
		}
		pi.feedback = packetFeedbackLost
		piRecv = *pi
		return
	}

	if pi.feedback == packetFeedbackLost {
		pi.feedback = packetFeedbackReceivedAfterLoss
	} else {
		pi.feedback = packetFeedbackReceived
	}
	if p.baseRecvTime == 0 {
		p.baseRecvTime = recvTime
	}

	pi.recvTime = recvTime - p.baseRecvTime
	piRecv = *pi
	if p.piLastRecv != nil {
		// Historical ACKs repair counts, not the current delay baseline.
		if pi.sequenceNumber < p.piLastRecv.sequenceNumber {
			return
		}
		sendDelta = pi.sendTime - p.piLastRecv.sendTime
		// TWCC is in send order, so receive times can go backwards. Retain the
		// receive watermark while send time advances and drains the old queue.
		recvDelta = max(0, pi.recvTime-p.lastRecvTime)
		p.lastRecvTime = max(p.lastRecvTime, pi.recvTime)
	} else {
		p.lastRecvTime = pi.recvTime
	}
	p.piLastRecv = pi
	return
}

func (p *packetTracker) getPacketInfo(sn uint16) *packetInfo {
	return &p.packetInfos[int(sn)%len(p.packetInfos)]
}

func (p *packetTracker) getPacketInfoExisting(sn uint16) *packetInfo {
	pi := &p.packetInfos[int(sn)%len(p.packetInfos)]
	if uint16(pi.sequenceNumber) == sn {
		return pi
	}

	return nil
}

func (p *packetTracker) ProbeClusterStarting(probeClusterId ccutils.ProbeClusterId) {
	p.lock.Lock()
	defer p.lock.Unlock()

	p.probeClusterId = probeClusterId
}

func (p *packetTracker) ProbeClusterDone(probeClusterId ccutils.ProbeClusterId) {
	p.lock.Lock()
	defer p.lock.Unlock()

	if p.probeClusterId == probeClusterId {
		p.probeClusterId = ccutils.ProbeClusterIdInvalid
	}
}

func (p *packetTracker) ProbeMaxSequenceNumber() uint64 {
	p.lock.Lock()
	defer p.lock.Unlock()

	return p.probeMaxSequenceNumber
}
