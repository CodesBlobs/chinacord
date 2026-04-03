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
      candidateQueue: [],
    };

    connection.ontrack = (event) => {
      const streams = event.streams;
      const track = event.track;

      if (streams && streams.length > 0) {
        for (const stream of streams) {
          for (const streamTrack of stream.getTracks()) {
            if (!peer.remoteStream.getTracks().some((existing) => existing.id === streamTrack.id)) {
              peer.remoteStream.addTrack(streamTrack);
            }
          }
        }
      } else if (track) {
        if (!peer.remoteStream.getTracks().some((existing) => existing.id === track.id)) {
          peer.remoteStream.addTrack(track);
        }
      }

      const notify = () => {
        this.onRemoteStream(peerId, peer.remoteStream);
      };

      track.onended = notify;
      track.onmute = notify;
      track.onunmute = notify;

      notify();
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

    connection.onnegotiationneeded = () => {
      this.renegotiate(peerId).catch(() => {});
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
    const micStream = await this.getLocalStream();
    for (const [peerId, peer] of this.peers.entries()) {
      const existingVideoSender = this.getVideoSender(peer.connection);

      if (videoTrack) {
        if (existingVideoSender) {
          if (existingVideoSender.track?.id !== videoTrack.id) {
            await existingVideoSender.replaceTrack(videoTrack);
          }
        } else {
          peer.connection.addTrack(videoTrack, micStream);
          await this.renegotiate(peerId);
        }
      } else if (existingVideoSender) {
        await existingVideoSender.replaceTrack(null);
        // After removing track, we might want to remove the sender entirely 
        // to keep SDP clean, but replaceTrack(null) is often enough.
        // To truly remove, we'd need to use removeTrack and renegotiate.
        const sender = this.getVideoSender(peer.connection);
        if (sender) {
          peer.connection.removeTrack(sender);
          await this.renegotiate(peerId);
        }
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

      // Process queued candidates
      for (const candidate of peer.candidateQueue) {
        await peer.connection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
      peer.candidateQueue = [];

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

      // Process queued candidates
      for (const candidate of peer.candidateQueue) {
        await peer.connection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
      peer.candidateQueue = [];
      return;
    }

    if (signal.type === "candidate") {
      if (peer.connection.remoteDescription && peer.connection.remoteDescription.type) {
        await peer.connection.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
      } else {
        peer.candidateQueue.push(signal.candidate);
      }
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
