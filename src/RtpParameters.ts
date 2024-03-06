/* eslint-disable @typescript-eslint/no-explicit-any */

export type RtpCapabilities = {
	codecs?: RtpCodecCapability[];
	headerExtensions?: RtpHeaderExtension[];
};

export type MediaKind = 'audio' | 'video';

export type RtpCodecCapability = {
	kind: MediaKind;
	mimeType: string;
	preferredPayloadType?: number;
	clockRate: number;
	channels?: number;
	parameters?: any;
	rtcpFeedback?: RtcpFeedback[];
};

export type RtpHeaderExtensionDirection =
	| 'sendrecv'
	| 'sendonly'
	| 'recvonly'
	| 'inactive';

export type RtpHeaderExtension = {
	kind: MediaKind;
	uri: RtpHeaderExtensionUri;
	preferredId: number;
	preferredEncrypt?: boolean;
	direction?: RtpHeaderExtensionDirection;
};

export type RtpParameters = {
	mid?: string;
	codecs: RtpCodecParameters[];
	headerExtensions?: RtpHeaderExtensionParameters[];
	encodings?: RtpEncodingParameters[];
	rtcp?: RtcpParameters;
};

export type RtpCodecParameters = {
	mimeType: string;
	payloadType: number;
	clockRate: number;
	channels?: number;
	parameters?: any;
	rtcpFeedback?: RtcpFeedback[];
};

export type RtcpFeedback = {
	type: string;
	parameter?: string;
};

export type RtpEncodingParameters = {
	ssrc?: number;
	rid?: string;
	codecPayloadType?: number
	rtx?: { ssrc: number };
	dtx?: boolean;
	scalabilityMode?: string;
	scaleResolutionDownBy?: number;
	maxBitrate?: number;
	maxFramerate?: number;
	adaptivePtime?: boolean;
	priority?: 'very-low' | 'low' | 'medium' | 'high';
	networkPriority?: 'very-low' | 'low' | 'medium' | 'high';
};

export type RtpHeaderExtensionUri =
	| 'urn:ietf:params:rtp-hdrext:sdes:mid'
	| 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id'
	| 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id'
	| 'http://tools.ietf.org/html/draft-ietf-avtext-framemarking-07'
	| 'urn:ietf:params:rtp-hdrext:framemarking'
	| 'urn:ietf:params:rtp-hdrext:ssrc-audio-level'
	| 'urn:3gpp:video-orientation'
	| 'urn:ietf:params:rtp-hdrext:toffset'
	| 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'
	| 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time'
	| 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';

export type RtpHeaderExtensionParameters = {
	uri: RtpHeaderExtensionUri;
	id: number;
	encrypt?: boolean;
	parameters?: any;
};

export type RtcpParameters = {
	cname?: string;
	reducedSize?: boolean;
	mux?: boolean;
};
