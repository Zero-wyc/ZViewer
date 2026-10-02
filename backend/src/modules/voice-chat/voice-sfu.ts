/**
 * mediasoup SFU 语音传输服务（v6 传输层重写）。
 *
 * 取代 v4 的「Opus 帧经 WebSocket 服务器中转」传输：语音改走 WebRTC
 * UDP（SRTP/DTLS），由 mediasoup SFU 按房间路由。解决 TCP 队头阻塞
 * 导致的秒级音频 gap/PLC（一条慢包拖住后续全部音频帧）。
 *
 * 架构：
 * - 单 Worker（语音场景 1 个足够），每房间一个 Router（仅 opus 编解码）
 * - 每个语音成员一个 WebRtcTransport（UDP），上行 produce 音频轨，
 *   下行 consume 同房间其他成员的全部音频轨
 * - 成员以语音身份键（user:{userId}[#{instanceId}] / socket:{socketId}）
 *   标识，与 voice-chat.handler 的成员表同键
 * - 禁言在 SFU 层强制：producer.pause() 后 RTP 直接停止，客户端无法绕过
 *
 * 信令（复用既有 socket.io 主连接，仅低频 offer/answer/ICE）：
 * - voice-sfu-rtp-capabilities → Router 能力
 * - voice-sfu-create-transport → WebRtcTransport 参数
 * - voice-sfu-connect-transport → DTLS 连接
 * - voice-sfu-produce → 上行音频轨，应答同时返回同房间其他成员轨的
 *   consumer 参数（新成员一次往返拿到全部现有音频）
 * - voice-sfu-resume-consumer → 恢复（consumer 初始为 paused）
 * - 广播 voice-sfu-new-producer：新成员加入后通知其他人消费
 *
 * 配置（环境变量）：
 * - MEDIASOUP_LISTEN_IP：默认 0.0.0.0
 * - MEDIASOUP_ANNOUNCED_IP：Docker/NAT 部署必须配置（对外通告 IP）
 * - MEDIASOUP_RTC_MIN_PORT / MEDIASOUP_RTC_MAX_PORT：UDP 端口范围，
 *   默认 40000-40100（Docker 需映射对应 UDP 端口段）
 * - pkg 单文件打包：mediasoup-worker 为独立二进制，随产物目录分发，
 *   启动时通过 MEDIASOUP_WORKER_BIN 指向（见 packaging 脚本）
 */
import * as mediasoup from 'mediasoup';
import { types as mediasoupTypes } from 'mediasoup';

/** 音频编码：仅 opus（与既有 WebCodecs 管线一致） */
const MEDIA_CODECS: mediasoupTypes.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
];

/** 单 Worker 足够语音场景；UDP 端口范围经环境变量可配 */
async function createWorker(): Promise<mediasoupTypes.Worker> {
  return mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: Number(process.env.MEDIASOUP_RTC_MIN_PORT ?? 40000),
    rtcMaxPort: Number(process.env.MEDIASOUP_RTC_MAX_PORT ?? 40100),
  });
}

/** 单个 SFU 成员的媒体状态 */
interface SfuPeer {
  /** WebRtcTransport（上行+下行共用） */
  transport: mediasoupTypes.WebRtcTransport;
  /** 显示名（信令透传，前端音频元素标注用） */
  username: string;
  /** 该成员的上行音频 Producer（produce 后填充） */
  producer: mediasoupTypes.Producer | null;
  /** 该成员消费其他成员的 Consumer 集合 */
  consumers: Set<mediasoupTypes.Consumer>;
}

interface SfuRoom {
  router: mediasoupTypes.Router;
  /** 成员身份键 → SFU 成员状态 */
  peers: Map<string, SfuPeer>;
}

class VoiceSfuService {
  private worker: mediasoupTypes.Worker | null = null;
  private workerCreating: Promise<mediasoupTypes.Worker> | null = null;
  /** roomId → 房间 SFU 状态（空房间即关闭） */
  private rooms = new Map<string, SfuRoom>();

  /** 惰性创建/获取 Worker（进程内单例） */
  private async getWorker(): Promise<mediasoupTypes.Worker> {
    if (this.worker) return this.worker;
    if (!this.workerCreating) {
      this.workerCreating = createWorker().then((worker) => {
        worker.on('died', () => {
          console.error('[voice-sfu] mediasoup Worker died, exiting in 2s...');
          setTimeout(() => process.exit(1), 2000);
        });
        this.worker = worker;
        this.workerCreating = null;
        console.log('[voice-sfu] mediasoup Worker created');
        return worker;
      });
    }
    return this.workerCreating;
  }

  /** 获取（或创建）房间 Router；房间内最后一个成员离开时由 closePeer 关闭 */
  private async getRoom(roomId: string): Promise<SfuRoom> {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    const worker = await this.getWorker();
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    const room: SfuRoom = { router, peers: new Map() };
    this.rooms.set(roomId, room);
    console.log(`[voice-sfu] Router created for room ${roomId}`);
    return room;
  }

  /** 房间 Router 的 RTP 能力（客户端 Device.load 用） */
  async getRouterRtpCapabilities(roomId: string): Promise<mediasoupTypes.RtpCapabilities> {
    const room = await this.getRoom(roomId);
    return room.router.rtpCapabilities;
  }

  /**
   * 为成员创建 WebRtcTransport（UDP），返回连接参数。
   * 同一成员重复调用返回既有 transport 的参数（幂等，重连恢复用）。
   */
  async createPeerTransport(
    roomId: string,
    key: string,
    username: string
  ): Promise<{
    id: string;
    iceParameters: mediasoupTypes.IceParameters;
    iceCandidates: mediasoupTypes.IceCandidate[];
    dtlsParameters: mediasoupTypes.DtlsParameters;
  }> {
    const room = await this.getRoom(roomId);
    let peer = room.peers.get(key);
    if (!peer) {
      const listenIp = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
      const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP || undefined;
      const transport = await room.router.createWebRtcTransport({
        listenIps: [{ ip: listenIp, announcedIp }],
        enableUdp: true,
        enableTcp: false,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 256_000,
      });
      transport.on('icestatechange', (state: string) => {
        if (state === 'disconnected' || state === 'failed') {
          console.warn(`[voice-sfu] transport ${state}: ${key} in ${roomId}`);
        }
      });
      peer = { transport, username, producer: null, consumers: new Set() };
      room.peers.set(key, peer);
    } else {
      // 重连/重入：刷新显示名
      peer.username = username;
    }
    return {
      id: peer.transport.id,
      iceParameters: peer.transport.iceParameters,
      iceCandidates: peer.transport.iceCandidates,
      dtlsParameters: peer.transport.dtlsParameters,
    };
  }

  /** 客户端 DTLS 连接（幂等：mediasoup connectTransport 重复调用会抛错，先查状态） */
  async connectPeerTransport(
    roomId: string,
    key: string,
    dtlsParameters: mediasoupTypes.DtlsParameters
  ): Promise<void> {
    const peer = this.rooms.get(roomId)?.peers.get(key);
    if (!peer) throw new Error('SFU transport 不存在，请重新加入语音');
    if (peer.transport.dtlsState === 'connected') return;
    await peer.transport.connect({ dtlsParameters });
  }

  /**
   * 成员上行产生音频轨。
   *
   * @returns producerId；同成员重复 produce（重连）时先关旧轨再建新轨
   */
  async produceAudio(
    roomId: string,
    key: string,
    rtpParameters: mediasoupTypes.RtpParameters
  ): Promise<{ producerId: string }> {
    const peer = this.rooms.get(roomId)?.peers.get(key);
    if (!peer) throw new Error('SFU transport 不存在，请重新加入语音');
    if (peer.producer) {
      // 重连场景：关旧轨（消费端会收到_producer 回收事件），建新轨
      try {
        peer.producer.close();
      } catch {
        /* ignore */
      }
      peer.producer = null;
    }
    const producer = await peer.transport.produce({
      kind: 'audio',
      rtpParameters,
      appData: { roomId, key },
    });
    producer.on('score', (score: mediasoupTypes.ProducerScore[]) => {
      // 上行质量评分（仅日志观测）
      const s = score[score.length - 1];
      if (s && s.score <= 4) {
        console.warn(`[voice-sfu] low uplink score=${s.score}: ${key}`);
      }
    });
    peer.producer = producer;
    // 服务器侧禁言强制：新轨直接暂停
    return { producerId: producer.id };
  }

  /**
   * 为成员创建对指定 Producer 的 Consumer。
   * Producer 归属的成员键由 SFU 内部解析（无需信令透传）。
   *
   * @param rtpCapabilities 请求方的 Router 能力（consume 校验用）
   * @returns consumer 参数 + 生产者归属的成员键（前端按成员挂 <audio>）
   */
  async consumeFrom(
    roomId: string,
    key: string,
    producerId: string,
    rtpCapabilities: mediasoupTypes.RtpCapabilities
  ): Promise<{
    consumerId: string;
    producerId: string;
    kind: string;
    rtpParameters: mediasoupTypes.RtpParameters;
    producerMemberKey: string;
    producerUsername: string;
  } | null> {
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(key);
    if (!room || !peer) throw new Error('SFU transport 不存在，请重新加入语音');
    // 找到目标 Producer（同房间其他成员的）
    let producer: mediasoupTypes.Producer | null = null;
    let producerMemberKey = '';
    let producerUsername = '';
    for (const [peerKey, p] of room.peers) {
      if (peerKey === key) continue;
      if (p.producer && p.producer.id === producerId) {
        producer = p.producer;
        producerMemberKey = peerKey;
        producerUsername = p.username;
        break;
      }
    }
    if (!producer || producer.closed) return null;

    const consumer = await peer.transport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // 客户端 attach <audio> 后显式 resume
      appData: { roomId, key, producerMemberKey },
    });
    peer.consumers.add(consumer);
    consumer.on('transportclose', () => {
      peer.consumers.delete(consumer);
    });
    return {
      consumerId: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerMemberKey,
      producerUsername,
    };
  }

  /**
   * 列出房间内其他成员的上行音频轨（新成员 produce 应答回带，
   * 客户端据此一次性 consume 全部现有音频）。
   */
  listProducers(
    roomId: string,
    excludeKey: string
  ): Array<{ producerId: string; memberKey: string; username: string }> {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const list: Array<{
      producerId: string;
      memberKey: string;
      username: string;
    }> = [];
    for (const [peerKey, p] of room.peers) {
      if (peerKey === excludeKey) continue;
      if (p.producer && !p.producer.closed && !p.producer.paused) {
        list.push({
          producerId: p.producer.id,
          memberKey: peerKey,
          username: p.username,
        });
      }
    }
    return list;
  }

  /** 客户端确认接收后恢复 Consumer（RTP 开始下发） */
  resumeConsumer(roomId: string, key: string, consumerId: string): void {
    const peer = this.rooms.get(roomId)?.peers.get(key);
    if (!peer) return;
    for (const consumer of peer.consumers) {
      if (consumer.id === consumerId) {
        void consumer.resume();
        return;
      }
    }
  }

  /** 服务器侧禁言强制：暂停/恢复成员的上行 Producer */
  setPeerMuted(roomId: string, key: string, muted: boolean): void {
    const producer = this.rooms.get(roomId)?.peers.get(key)?.producer;
    if (!producer) return;
    if (muted && !producer.paused) {
      void producer.pause();
    } else if (!muted && producer.paused) {
      void producer.resume();
    }
  }

  /** 成员离开语音：关闭其 transport（连带 producer/consumers），空房间关 Router */
  closePeer(roomId: string, key: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const peer = room.peers.get(key);
    if (!peer) return;
    room.peers.delete(key);
    try {
      peer.transport.close();
    } catch {
      /* ignore */
    }
    if (room.peers.size === 0) {
      try {
        room.router.close();
      } catch {
        /* ignore */
      }
      this.rooms.delete(roomId);
      console.log(`[voice-sfu] Router closed for room ${roomId}`);
    }
  }

  /** 成员的上行 Producer 是否存在（信令校验用） */
  hasProducer(roomId: string, producerId: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    for (const [peerKey, p] of room.peers) {
      if (p.producer && p.producer.id === producerId) return peerKey;
    }
    return null;
  }
}

/** 全局单例（与 VoiceChatHandler 同生命周期） */
export const voiceSfu = new VoiceSfuService();
