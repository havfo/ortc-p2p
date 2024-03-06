import { EnhancedEventEmitter } from '../EnhancedEventEmitter';
import { ProducerCodecOptions } from '../Producer';
import { IceParameters, IceCandidate, DtlsParameters, IceGatheringState, DtlsRole, IceConnectionState } from '../Transport';
import { RtpCapabilities, RtpCodecCapability, RtpParameters } from '../RtpParameters';
import { SctpCapabilities, SctpParameters, SctpStreamParameters } from '../SctpParameters';
import { RemoteSdp } from './sdp/RemoteSdp';
import * as utils from '../utils';
import * as sdpUnifiedPlanUtils from './sdp/unifiedPlanUtils';
import * as ortc from '../ortc';
import * as sdpTransform from 'sdp-transform';
import * as sdpCommonUtils from './sdp/commonUtils';
import { InvalidStateError } from '../errors';
import { Logger } from '../Logger';
export type HandlerFactory = () => HandlerInterface;

const logger = new Logger('Handler');

export type HandlerRunOptions = {
	direction: 'send' | 'recv';
	iceParameters?: IceParameters;
	iceCandidates?: IceCandidate[];
	dtlsParameters?: DtlsParameters;
	sctpParameters?: SctpParameters;
	iceServers?: RTCIceServer[];
	iceTransportPolicy?: RTCIceTransportPolicy;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	additionalSettings?: any;
	extendedRtpCapabilities: RtpCapabilities;
};

export type HandlerSendOptions = {
	track: MediaStreamTrack;
	codecOptions?: ProducerCodecOptions;
	codec?: RtpCodecCapability;
};

export type HandlerSendResult = {
	id: string;
	localId: string;
	rtpParameters: RtpParameters;
	rtpSender?: RTCRtpSender;
};

export type HandlerReceiveOptions = {
	trackId: string;
	kind: 'audio' | 'video';
	rtpParameters: RtpParameters;
	streamId?: string;
};

export type HandlerReceiveResult = {
	localId: string;
	track: MediaStreamTrack;
	rtpReceiver?: RTCRtpReceiver;
};

export type HandlerSendDataChannelOptions = SctpStreamParameters;

export type HandlerSendDataChannelResult = {
	dataChannel: RTCDataChannel;
	sctpStreamParameters: SctpStreamParameters;
};

export type HandlerReceiveDataChannelOptions = {
	sctpStreamParameters: SctpStreamParameters;
	label: string;
	protocol?: string;
};

export type HandlerReceiveDataChannelResult = {
	dataChannel: RTCDataChannel;
};

export type HandlerEvents = {
	'@close': [];
	'@connect': [ { dtlsParameters: DtlsParameters; iceParameters: IceParameters; }, () => void, (error: Error) => void ];
	'@icecandidate': [RTCIceCandidate | null];
	'@icegatheringstatechange': [IceGatheringState];
	'@iceconnectionstatechange': [ IceConnectionState ];
};

export abstract class HandlerInterface extends EnhancedEventEmitter<HandlerEvents> {
	// Closed flag.
	public closed = false;
	// Generic sending RTP parameters for audio and video.
	protected _sendingRtpParametersByKind?: { [key: string]: RtpParameters };
	// Generic sending RTP parameters for audio and video suitable for the SDP
	// remote answer.
	protected _sendingRemoteRtpParametersByKind?: { [key: string]: RtpParameters };
	// Handler direction.
	protected _direction?: 'send' | 'recv';
	// Map of RTCTransceivers indexed by MID.
	protected readonly _mapMidTransceiver: Map<string, RTCRtpTransceiver> = new Map();
	// Remote SDP handler.
	protected _remoteSdp?: RemoteSdp;
	// RTCPeerConnection instance.
	public pc!: RTCPeerConnection;
	// Local stream for sending.
	protected readonly _sendStream = new MediaStream();
	// Whether a DataChannel m=application section has been created.
	protected _hasDataChannelMediaSection = false;
	// Got transport local and remote parameters.
	protected _transportReady = false;
	// Have setup transport local
	protected _transportSetup = false;

	abstract get name(): string;

	run({
		direction,
		iceParameters,
		iceCandidates,
		dtlsParameters,
		sctpParameters,
		iceServers,
		iceTransportPolicy,
		additionalSettings,
		extendedRtpCapabilities,
	}: HandlerRunOptions): void {
		this.assertNotClosed();

		this.pc = new RTCPeerConnection({
			iceServers: iceServers || [],
			iceTransportPolicy: iceTransportPolicy || 'all',
			bundlePolicy: 'max-bundle',
			rtcpMuxPolicy: 'require',
			...additionalSettings,
		});

		this._direction = direction;

		this._remoteSdp = new RemoteSdp({ iceParameters, iceCandidates, dtlsParameters, sctpParameters });

		this._sendingRtpParametersByKind = {
			audio: ortc.getSendingRtpParameters('audio', extendedRtpCapabilities),
			video: ortc.getSendingRtpParameters('video', extendedRtpCapabilities),
		};

		this._sendingRemoteRtpParametersByKind = {
			audio: ortc.getSendingRemoteRtpParameters('audio', extendedRtpCapabilities),
			video: ortc.getSendingRemoteRtpParameters('video', extendedRtpCapabilities),
		};

		this.pc.addEventListener('icecandidate', ({ candidate }) => this.emit('@icecandidate', candidate));
		this.pc.addEventListener('icegatheringstatechange', () => this.emit('@icegatheringstatechange', this.pc.iceGatheringState));
		this.pc.addEventListener('iceconnectionstatechange', () => this.emit('@iceconnectionstatechange', this.pc.iceConnectionState));
	}

	close(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;

		this.pc?.close();
		this.emit('@close');
	}

	abstract getNativeRtpCapabilities(): Promise<RtpCapabilities>;
	abstract getNativeSctpCapabilities(): Promise<SctpCapabilities>;

	async updateIceServers(iceServers: RTCIceServer[]): Promise<void> {
		this.assertNotClosed();

		const configuration = this.pc.getConfiguration();

		configuration.iceServers = iceServers;
		this.pc.setConfiguration(configuration);
	}

	async restartIce(iceParameters: IceParameters): Promise<void> {
		this.assertNotClosed();

		this._remoteSdp!.updateIceParameters(iceParameters);

		if (!this._transportReady) {
			return;
		}

		if (this._direction === 'send') {
			const offer = await this.pc.createOffer({ iceRestart: true });

			await this.pc.setLocalDescription(offer);
			await this.pc.setRemoteDescription({ type: 'answer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription);
		} else {
			await this.pc.setRemoteDescription({ type: 'offer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription);
			const answer = await this.pc.createAnswer();

			await this.pc.setLocalDescription(answer);
		}
	}

	async getTransportStats(): Promise<RTCStatsReport> {
		this.assertNotClosed();

		return this.pc.getStats();
	}

	async send({ track, codecOptions, codec }: HandlerSendOptions): Promise<HandlerSendResult> {
		this.assertNotClosed();
		this.assertSendDirection();

		const sendingRtpParameters = utils.clone<RtpParameters>(this._sendingRtpParametersByKind![track.kind]);

		// This may throw.
		sendingRtpParameters.codecs = ortc.reduceCodecs(sendingRtpParameters.codecs, codec);

		const sendingRemoteRtpParameters = utils.clone<RtpParameters>(this._sendingRemoteRtpParametersByKind![track.kind]);

		// This may throw.
		sendingRemoteRtpParameters.codecs = ortc.reduceCodecs(sendingRemoteRtpParameters.codecs, codec);

		const mediaSectionIdx = this._remoteSdp!.getNextMediaSectionIdx();
		const transceiver = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [ this._sendStream ] });
		const offer = await this.pc.createOffer();
		let localSdpObject = sdpTransform.parse(offer.sdp!);

		logger.debug('send() [offer:%s]', offer);

		if (!this._transportSetup) {
			await this.setupTransport({ localDtlsRole: 'client', localSdpObject });
		}

		await this.pc.setLocalDescription(offer);

		const localId = transceiver.mid!;

		sendingRtpParameters.mid = localId;
		localSdpObject = sdpTransform.parse(this.pc.localDescription!.sdp);
	
		const offerMediaObject = localSdpObject.media[mediaSectionIdx.idx];

		sendingRtpParameters.rtcp!.cname = sdpCommonUtils.getCname({ offerMediaObject });
		sendingRtpParameters.encodings = sdpUnifiedPlanUtils.getRtpEncodings({ offerMediaObject });

		this._remoteSdp!.send({
			offerMediaObject,
			reuseMid: mediaSectionIdx.reuseMid,
			offerRtpParameters: sendingRtpParameters,
			answerRtpParameters: sendingRemoteRtpParameters,
			codecOptions,
			extmapAllowMixed: true,
		});

		if (this._transportReady) {
			const answer = this._remoteSdp!.getSdp();

			logger.debug('send() [answer:%s]', answer);

			await this.pc.setRemoteDescription({ type: 'answer', sdp: answer } as RTCSessionDescription);
		}

		this._mapMidTransceiver.set(localId, transceiver);

		return {
			id: track.id,
			localId,
			rtpParameters: sendingRtpParameters,
			rtpSender: transceiver.sender,
		};
	}

	async stopSending(localId: string): Promise<void> {
		this.assertSendDirection();

		if (this.closed) {
			return;
		}

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		transceiver.sender.replaceTrack(null);
		this.pc.removeTrack(transceiver.sender);

		const mediaSectionClosed = this._remoteSdp!.closeMediaSection(transceiver.mid!);

		if (mediaSectionClosed) {
			try {
				transceiver.stop();
			} catch (error) { }
		}

		const offer = await this.pc.createOffer();

		await this.pc.setLocalDescription(offer);
		await this.pc.setRemoteDescription({ type: 'answer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription);

		this._mapMidTransceiver.delete(localId);
	}

	async pauseSending(localId: string): Promise<void> {
		this.assertNotClosed();
		this.assertSendDirection();

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		transceiver.direction = 'inactive';
		this._remoteSdp!.pauseMediaSection(localId);

		const offer = await this.pc.createOffer();

		await this.pc.setLocalDescription(offer);
		await this.pc.setRemoteDescription({ type: 'answer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription);
	}

	async resumeSending(localId: string): Promise<void> {
		this.assertNotClosed();
		this.assertSendDirection();

		const transceiver = this._mapMidTransceiver.get(localId);

		this._remoteSdp!.resumeSendingMediaSection(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		transceiver.direction = 'sendonly';

		const offer = await this.pc.createOffer();

		await this.pc.setLocalDescription(offer);
		await this.pc.setRemoteDescription({ type: 'answer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription);
	}

	async replaceTrack(localId: string, track: MediaStreamTrack | null): Promise<void> {
		this.assertNotClosed();
		this.assertSendDirection();

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		await transceiver.sender.replaceTrack(track);
	}

	async getSenderStats(localId: string): Promise<RTCStatsReport> {
		this.assertNotClosed();
		this.assertSendDirection();

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		return transceiver.sender.getStats();
	}

	abstract sendDataChannel(options: HandlerSendDataChannelOptions): Promise<HandlerSendDataChannelResult>;

	async receive(optionsList: HandlerReceiveOptions[]): Promise<HandlerReceiveResult[]> {
		this.assertNotClosed();
		this.assertRecvDirection();

		const results: HandlerReceiveResult[] = [];
		const mapLocalId: Map<string, string> = new Map();

		for (const options of optionsList) {
			const { trackId, kind, rtpParameters, streamId } = options;
			const localId = rtpParameters.mid || String(this._mapMidTransceiver.size);

			mapLocalId.set(trackId, localId);

			this._remoteSdp!.receive({
				mid: localId,
				kind,
				offerRtpParameters: rtpParameters,
				streamId: streamId || rtpParameters.rtcp!.cname!,
				trackId,
			});
		}

		const offer = this._remoteSdp!.getSdp();

		logger.debug('receive() [offer:%s]', offer);

		await this.pc.setRemoteDescription({ type: 'offer', sdp: offer } as RTCSessionDescription);

		let answer = await this.pc.createAnswer();
		const localSdpObject = sdpTransform.parse(answer.sdp!);

		for (const options of optionsList) {
			const { trackId, rtpParameters } = options;
			const localId = mapLocalId.get(trackId);
			const answerMediaObject = localSdpObject.media.find((m) => String(m.mid) === localId);

			sdpCommonUtils.applyCodecParameters({ offerRtpParameters: rtpParameters, answerMediaObject: answerMediaObject! });
		}

		answer = { type: 'answer', sdp: sdpTransform.write(localSdpObject) };

		if (!this._transportReady) {
			await this.setupTransport({ localDtlsRole: 'server', localSdpObject });
		}

		logger.debug('receive() [answer:%s]', answer.sdp);

		await this.pc.setLocalDescription(answer);

		for (const options of optionsList) {
			const { trackId } = options;
			const localId = mapLocalId.get(trackId)!;
			const transceiver = this.pc.getTransceivers().find((t) => t.mid === localId);

			if (!transceiver) {
				throw new Error('new RTCRtpTransceiver not found');
			}
			
			this._mapMidTransceiver.set(localId, transceiver);
			results.push({ localId, track: transceiver.receiver.track, rtpReceiver: transceiver.receiver });
		}

		return results;
	}

	async pauseReceiving(localIds: string[]): Promise<void> {
		this.assertNotClosed();
		this.assertRecvDirection();

		for (const localId of localIds) {
			const transceiver = this._mapMidTransceiver.get(localId);

			if (!transceiver) {
				throw new Error('associated RTCRtpTransceiver not found');
			}

			transceiver.direction = 'inactive';
			this._remoteSdp!.pauseMediaSection(localId);
		}

		await this.pc.setRemoteDescription({ type: 'offer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription);
		const answer = await this.pc.createAnswer();

		await this.pc.setLocalDescription(answer);
	}

	async resumeReceiving(localIds: string[]): Promise<void> {
		this.assertNotClosed();
		this.assertRecvDirection();

		for (const localId of localIds) {
			const transceiver = this._mapMidTransceiver.get(localId);

			if (!transceiver) {
				throw new Error('associated RTCRtpTransceiver not found');
			}

			transceiver.direction = 'recvonly';
			this._remoteSdp!.resumeReceivingMediaSection(localId);
		}

		await this.pc.setRemoteDescription({ type: 'offer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription);
		const answer = await this.pc.createAnswer();

		await this.pc.setLocalDescription(answer);
	}

	async getReceiverStats(localId: string): Promise<RTCStatsReport> {
		this.assertNotClosed();
		this.assertRecvDirection();

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		return transceiver.receiver.getStats();
	}

	async stopReceiving(localIds: string[]): Promise<void> {
		this.assertRecvDirection();

		if (this.closed) {
			return;
		}

		for (const localId of localIds) {
			const transceiver = this._mapMidTransceiver.get(localId);

			if (!transceiver) {
				throw new Error('associated RTCRtpTransceiver not found');
			}

			this._remoteSdp!.closeMediaSection(transceiver.mid!);
		}

		await this.pc.setRemoteDescription({ type: 'offer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription);
		const answer = await this.pc.createAnswer();

		await this.pc.setLocalDescription(answer);

		for (const localId of localIds) {
			this._mapMidTransceiver.delete(localId);
		}
	}

	async receiveDataChannel({
		sctpStreamParameters,
		label,
		protocol,
	}: HandlerReceiveDataChannelOptions): Promise<HandlerReceiveDataChannelResult> {
		this.assertNotClosed();
		this.assertRecvDirection();

		const {
			streamId,
			ordered,
			maxPacketLifeTime,
			maxRetransmits,
		}: SctpStreamParameters = sctpStreamParameters;

		const options = {
			negotiated: true,
			id: streamId,
			ordered,
			maxPacketLifeTime,
			maxRetransmits,
			protocol,
		};

		const dataChannel = this.pc.createDataChannel(label, options);

		if (!this._hasDataChannelMediaSection) {
			this._remoteSdp!.receiveSctpAssociation();

			await this.pc.setRemoteDescription({ type: 'offer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription);
			const answer = await this.pc.createAnswer();

			if (!this._transportReady) {
				await this.setupTransport({ localDtlsRole: 'server', localSdpObject: sdpTransform.parse(answer.sdp!) });
			}

			await this.pc.setLocalDescription(answer);

			this._hasDataChannelMediaSection = true;
		}

		return { dataChannel };
	}

	async onRemoteIceCandidate(candidate: RTCIceCandidate | null): Promise<void> {
		this.assertNotClosed();

		logger.debug('onRemoteIceCandidate() [candidate:%o]', candidate);

		// @ts-expect-error Object is possibly 'null'.
		await this.pc.addIceCandidate(candidate);
	}

	async connect({ dtlsParameters, iceParameters }: { dtlsParameters: DtlsParameters; iceParameters: IceParameters; }): Promise<void> {
		this.assertNotClosed();

		logger.debug('connect() [dtlsParameters:%o, iceParameters:%o]', dtlsParameters, iceParameters);

		this._remoteSdp!.updateIceParameters(iceParameters);
		this._remoteSdp!.updateDtlsParameters(dtlsParameters);

		if (this._direction === 'recv') {
			return;
		}

		await this.pc.setRemoteDescription({ type: 'answer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription);

		this._transportReady = true;
	}

	protected async setupTransport({ localDtlsRole, localSdpObject }: { localDtlsRole: DtlsRole; localSdpObject?: sdpTransform.SessionDescription; }): Promise<void> {
		if (!localSdpObject) {
			localSdpObject = sdpTransform.parse(this.pc.localDescription!.sdp);
		}

		const dtlsParameters = sdpCommonUtils.extractDtlsParameters({ sdpObject: localSdpObject });
		const iceParameters = sdpCommonUtils.extractIceParameters({ sdpObject: localSdpObject });

		dtlsParameters.role = localDtlsRole;

		await new Promise<void>((resolve, reject) => this.safeEmit('@connect', { dtlsParameters, iceParameters }, resolve, reject));

		if (this._direction === 'recv') {
			this._transportReady = true;
		}

		this._transportSetup = true;
	}

	protected assertNotClosed(): void {
		if (this.closed) {
			throw new InvalidStateError('method called in a closed handler');
		}
	}

	protected assertSendDirection(): void {
		if (this._direction !== 'send') {
			throw new Error('method can just be called for handlers with "send" direction');
		}
	}

	protected assertRecvDirection(): void {
		if (this._direction !== 'recv') {
			throw new Error('method can just be called for handlers with "recv" direction');
		}
	}
}
