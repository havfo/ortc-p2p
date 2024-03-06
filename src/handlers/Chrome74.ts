import * as sdpTransform from 'sdp-transform';
import { Logger } from '../Logger';
import * as sdpCommonUtils from './sdp/commonUtils';
import * as ortcUtils from './ortc/utils';
import {
	HandlerFactory,
	HandlerInterface,
	HandlerSendDataChannelOptions,
	HandlerSendDataChannelResult,
} from './HandlerInterface';
import { RtpCapabilities } from '../RtpParameters';
import { SctpCapabilities, SctpStreamParameters } from '../SctpParameters';

const logger = new Logger('Chrome74');

const SCTP_NUM_STREAMS = { OS: 1024, MIS: 1024 };

export class Chrome74 extends HandlerInterface {
	// Sending DataChannel id value counter. Incremented for each new DataChannel.
	private _nextSendSctpStreamId = 0;

	static createFactory(): HandlerFactory {
		return (): Chrome74 => new Chrome74();
	}

	get name(): string {
		return 'Chrome74';
	}

	async getNativeRtpCapabilities(): Promise<RtpCapabilities> {
		logger.debug('getNativeRtpCapabilities()');

		const pc = new RTCPeerConnection({
			iceServers: [],
			iceTransportPolicy: 'all',
			bundlePolicy: 'max-bundle',
			rtcpMuxPolicy: 'require',
		});

		try {
			pc.addTransceiver('audio');
			pc.addTransceiver('video');

			const offer = await pc.createOffer();

			try {
				pc.close();
			} catch (error) { }

			const sdpObject = sdpTransform.parse(offer.sdp!);
			const nativeRtpCapabilities = sdpCommonUtils.extractRtpCapabilities({ sdpObject });

			// libwebrtc supports NACK for OPUS but doesn't announce it.
			ortcUtils.addNackSuppportForOpus(nativeRtpCapabilities);

			return nativeRtpCapabilities;
		} catch (error) {
			try {
				pc.close();
			} catch (error2) { }

			throw error;
		}
	}

	async getNativeSctpCapabilities(): Promise<SctpCapabilities> {
		return { numStreams: SCTP_NUM_STREAMS };
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
