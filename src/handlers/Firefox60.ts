import * as sdpTransform from 'sdp-transform';
import { Logger } from '../Logger';
import * as utils from '../utils';
import * as ortc from '../ortc';
import * as sdpCommonUtils from './sdp/commonUtils';
import * as sdpUnifiedPlanUtils from './sdp/unifiedPlanUtils';
import {
	HandlerFactory,
	HandlerInterface,
	HandlerSendOptions,
	HandlerSendResult,
	HandlerSendDataChannelOptions,
	HandlerSendDataChannelResult,
} from './HandlerInterface';
import { RtpCapabilities, RtpParameters } from '../RtpParameters';
import { SctpCapabilities, SctpStreamParameters } from '../SctpParameters';

const logger = new Logger('Firefox60');

const SCTP_NUM_STREAMS = { OS: 16, MIS: 2048 };

export class Firefox60 extends HandlerInterface {
	// Sending DataChannel id value counter. Incremented for each new DataChannel.
	private _nextSendSctpStreamId = 0;

	static createFactory(): HandlerFactory {
		return (): Firefox60 => new Firefox60();
	}

	get name(): string {
		return 'Firefox60';
	}

	async getNativeRtpCapabilities(): Promise<RtpCapabilities> {
		logger.debug('getNativeRtpCapabilities()');

		const pc = new RTCPeerConnection({
			iceServers: [],
			iceTransportPolicy: 'all',
			bundlePolicy: 'max-bundle',
			rtcpMuxPolicy: 'require',
		});

		// NOTE: We need to add a real video track to get the RID extension mapping.
		const canvas = document.createElement('canvas');

		// NOTE: Otherwise Firefox fails in next line.
		canvas.getContext('2d');

		const fakeStream = canvas.captureStream();
		const fakeVideoTrack = fakeStream.getVideoTracks()[0];

		try {
			pc.addTransceiver('audio', { direction: 'sendrecv' });

			const videoTransceiver = pc.addTransceiver(fakeVideoTrack, { direction: 'sendrecv' });
			const parameters = videoTransceiver.sender.getParameters();
			const encodings = [
				{ rid: 'r0', maxBitrate: 100000 },
				{ rid: 'r1', maxBitrate: 500000 },
			];

			parameters.encodings = encodings;
			await videoTransceiver.sender.setParameters(parameters);

			const offer = await pc.createOffer();

			try {
				canvas.remove();
			} catch (error) { }

			try {
				fakeVideoTrack.stop();
			} catch (error) { }

			try {
				pc.close();
			} catch (error) { }

			const sdpObject = sdpTransform.parse(offer.sdp!);
			const nativeRtpCapabilities = sdpCommonUtils.extractRtpCapabilities({ sdpObject });

			return nativeRtpCapabilities;
		} catch (error) {
			try {
				canvas.remove();
			} catch (error2) { }

			try {
				fakeVideoTrack.stop();
			} catch (error2) { }

			try {
				pc.close();
			} catch (error2) { }

			throw error;
		}
	}

	async getNativeSctpCapabilities(): Promise<SctpCapabilities> {
		return { numStreams: SCTP_NUM_STREAMS };
	}

	async send({ track, codecOptions, codec }: HandlerSendOptions): Promise<HandlerSendResult> {
		this.assertNotClosed();
		this.assertSendDirection();

		logger.debug('send() [kind:%s, track.id:%s]', track.kind, track.id);

		const sendingRtpParameters = utils.clone<RtpParameters>(this._sendingRtpParametersByKind![track.kind]);

		// This may throw.
		sendingRtpParameters.codecs = ortc.reduceCodecs(sendingRtpParameters.codecs, codec);

		const sendingRemoteRtpParameters = utils.clone<RtpParameters>(this._sendingRemoteRtpParametersByKind![track.kind]);

		// This may throw.
		sendingRemoteRtpParameters.codecs = ortc.reduceCodecs(sendingRemoteRtpParameters.codecs, codec);

		// NOTE: Firefox fails sometimes to properly anticipate the closed media
		// section that it should use, so don't reuse closed media sections.
		//   https://github.com/versatica/mediasoup-client/issues/104
		//
		// const mediaSectionIdx = this._remoteSdp!.getNextMediaSectionIdx();
		const transceiver = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [ this._sendStream ] });

		const offer = await this.pc.createOffer();
		let localSdpObject = sdpTransform.parse(offer.sdp!);

		if (!this._transportSetup) {
			await this.setupTransport({ localDtlsRole: 'client', localSdpObject });
		}

		logger.debug('send() | calling pc.setLocalDescription() [offer:%o]', offer);

		await this.pc.setLocalDescription(offer);

		const localId = transceiver.mid!;

		sendingRtpParameters.mid = localId;
		localSdpObject = sdpTransform.parse(this.pc.localDescription!.sdp);

		const offerMediaObject = localSdpObject.media[localSdpObject.media.length - 1];

		sendingRtpParameters.rtcp!.cname = sdpCommonUtils.getCname({ offerMediaObject });
		sendingRtpParameters.encodings = sdpUnifiedPlanUtils.getRtpEncodings({ offerMediaObject });

		this._remoteSdp!.send({
			offerMediaObject,
			offerRtpParameters: sendingRtpParameters,
			answerRtpParameters: sendingRemoteRtpParameters,
			codecOptions,
			extmapAllowMixed: true,
		});

		if (this._transportReady) {
			const answer = { type: 'answer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription;

			logger.debug('send() | calling pc.setRemoteDescription() [answer:%o]', answer);

			await this.pc.setRemoteDescription(answer);
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

		logger.debug('stopSending() [localId:%s]', localId);

		if (this.closed) {
			return;
		}

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated transceiver not found');
		}

		transceiver.sender.replaceTrack(null);

		this.pc.removeTrack(transceiver.sender);
		this._remoteSdp!.disableMediaSection(transceiver.mid!);

		const offer = await this.pc.createOffer();

		logger.debug('stopSending() | calling pc.setLocalDescription() [offer:%o]', offer);

		await this.pc.setLocalDescription(offer);

		const answer = { type: 'answer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription;

		logger.debug('stopSending() | calling pc.setRemoteDescription() [answer:%o]', answer);

		await this.pc.setRemoteDescription(answer);

		this._mapMidTransceiver.delete(localId);
	}

	async sendDataChannel({
		ordered,
		maxPacketLifeTime,
		maxRetransmits,
		label,
		protocol,
	}: HandlerSendDataChannelOptions): Promise<HandlerSendDataChannelResult> {
		this.assertNotClosed();
		this.assertSendDirection();

		const options = {
			negotiated: true,
			id: this._nextSendSctpStreamId,
			ordered,
			maxPacketLifeTime,
			maxRetransmits,
			protocol,
		};

		logger.debug('sendDataChannel() [options:%o]', options);

		const dataChannel = this.pc.createDataChannel(label, options);

		this._nextSendSctpStreamId = ++this._nextSendSctpStreamId % SCTP_NUM_STREAMS.MIS;

		if (!this._hasDataChannelMediaSection) {
			const offer = await this.pc.createOffer();
			const localSdpObject = sdpTransform.parse(offer.sdp!);
			const offerMediaObject = localSdpObject.media.find((m) => m.type === 'application');

			if (!this._transportReady) {
				await this.setupTransport({ localDtlsRole: 'client', localSdpObject });
			}

			logger.debug('sendDataChannel() | calling pc.setLocalDescription() [offer:%o]', offer);

			await this.pc.setLocalDescription(offer);

			this._remoteSdp!.sendSctpAssociation({ offerMediaObject });

			const answer = { type: 'answer', sdp: this._remoteSdp!.getSdp() } as RTCSessionDescription;

			logger.debug('sendDataChannel() | calling pc.setRemoteDescription() [answer:%o]', answer);

			await this.pc.setRemoteDescription(answer);

			this._hasDataChannelMediaSection = true;
		}

		const sctpStreamParameters: SctpStreamParameters = {
			label,
			streamId: options.id,
			ordered: options.ordered,
			maxPacketLifeTime: options.maxPacketLifeTime,
			maxRetransmits: options.maxRetransmits,
		};

		return { dataChannel, sctpStreamParameters };
	}
}
