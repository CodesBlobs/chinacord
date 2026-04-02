export class VoiceMesh {
  constructor(options) {
    this.selfId = options.selfId;
    this.getLocalStream = options.getLocalStream;
    this.getExtraTracks = options.getExtraTracks;
    this.sendSignal = options.sendSignal;
    this.onRemoteStream = options.onRemoteStream;
    this.onPeerState = options.onPeerState;
    this.iceServers = options.iceServers;
    this.peers = new Map();
  }

  ensurePeer(peerId) {
    if (this.peers.has(peerId)) {
      return this.peers.get(peerId);
    }

    const connection = new RTCPeerConnection({
      iceServers: this.iceServers,
    });

    const peer = {
      id: peerId,
      connection,
      remoteStream: new MediaStream(),
    };

    connection.ontrack = (event) => {
      for (const track of event.streams[0].getTracks()) {
        if (!peer.remoteStream.getTracks().some((existing) => existing.id === track.id)) {
          peer.remoteStream.addTrack(track);
        }
      }
      this.onRemoteStream(peerId, peer.remoteStream);
    };

    connection.onconnectionstatechange = () => {
      this.onPeerState(peerId, connection.connectionState);
      if (["failed", "closed", "disconnected"].includes(connection.connectionState)) {
        this.closePeer(peerId);
      }
    };

    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      // ICE candidates are the network hints WebRTC needs to complete the
      // direct audio path. They are forwarded through the signaling server so
      // peers on different devices and networks can finish negotiation.
      this.sendSignal(peerId, {
        type: "candidate",
        candidate: event.candidate,
      });
    };

    this.peers.set(peerId, peer);
    this.attachLocalTracks(peerId).catch(() => {});
    return peer;
  }

  async attachLocalTracks(peerId) {
    const stream = await this.getLocalStream();
    const peer = this.ensurePeer(peerId);
    const existingSenders = peer.connection.getSenders();
    const extraTracks = this.getExtraTracks ? await this.getExtraTracks() : [];
    const tracks = [...stream.getTracks(), ...extraTracks];

    for (const track of tracks) {
      if (!existingSenders.some((sender) => sender.track && sender.track.id === track.id)) {
        peer.connection.addTrack(track, stream);
      }
    }
  }

  async createOffer(peerId) {
    const peer = this.ensurePeer(peerId);
    await this.attachLocalTracks(peerId);

    // The new joiner creates the first offer. That avoids glare because we do
    // not let both sides send an offer at the same time.
    const offer = await peer.connection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await peer.connection.setLocalDescription(offer);
    this.sendSignal(peerId, {
      type: "offer",
      sdp: offer,
    });
  }

  async setVideoTrack(videoTrack) {
    for (const [peerId, peer] of this.peers.entries()) {
      const existingVideoSender = this.getVideoSender(peer.connection);

      if (videoTrack) {
        if (existingVideoSender) {
          await existingVideoSender.replaceTrack(videoTrack);
        } else {
          peer.connection.addTrack(videoTrack, new MediaStream([videoTrack]));
          await this.renegotiate(peerId);
        }
      } else if (existingVideoSender) {
        await existingVideoSender.replaceTrack(null);
        await this.renegotiate(peerId);
      }
    }
  }

  getVideoSender(connection) {
    const senderWithTrack = connection
      .getSenders()
      .find((sender) => sender.track && sender.track.kind === "video");
    if (senderWithTrack) {
      return senderWithTrack;
    }

    const transceiver = connection
      .getTransceivers()
      .find((item) => item.receiver?.track?.kind === "video");
    return transceiver?.sender || null;
  }

  async renegotiate(peerId) {
    const peer = this.ensurePeer(peerId);
    if (peer.connection.signalingState !== "stable") {
      return;
    }

    const offer = await peer.connection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await peer.connection.setLocalDescription(offer);
    this.sendSignal(peerId, {
      type: "offer",
      sdp: offer,
    });
  }

  async handleSignal(message) {
    if (!message || message.toUserId !== this.selfId) {
      return;
    }

    const peerId = message.fromUserId;
    const signal = message.signal;
    const peer = this.ensurePeer(peerId);

    if (signal.type === "offer") {
      await this.attachLocalTracks(peerId);
      await peer.connection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      this.sendSignal(peerId, {
        type: "answer",
        sdp: answer,
      });
      return;
    }

    if (signal.type === "answer") {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      return;
    }

    if (signal.type === "candidate") {
      await peer.connection.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  }

  closePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return;
    }
    peer.connection.onicecandidate = null;
    peer.connection.ontrack = null;
    peer.connection.close();
    this.peers.delete(peerId);
  }

  closeAll() {
    for (const peerId of Array.from(this.peers.keys())) {
      this.closePeer(peerId);
    }
  }
}
