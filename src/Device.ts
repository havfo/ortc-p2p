import { UAParser } from 'ua-parser-js';
import { Logger } from './Logger';
import { EnhancedEventEmitter } from './EnhancedEventEmitter';
import { UnsupportedError, InvalidStateError } from './errors';
import * as utils from './utils';
import * as ortc from './ortc';
import { Transport, TransportOptions, CanProduceByKind } from './Transport';
import { HandlerFactory, HandlerInterface } from './handlers/HandlerInterface';
import { Chrome74 } from './handlers/Chrome74';
import { Firefox60 } from './handlers/Firefox60';
import { Safari12 } from './handlers/Safari12';
import { RtpCapabilities, MediaKind } from './RtpParameters';
import { SctpCapabilities } from './SctpParameters';
import { AppData } from './types';

const logger = new Logger('Device');

export type BuiltinHandlerName =
	| 'Chrome74'
	| 'Firefox60'
	| 'Safari12';

export type DeviceOptions = {
	handlerName?: BuiltinHandlerName;
	handlerFactory?: HandlerFactory;
	Handler?: string;
};

export function detectDevice(): BuiltinHandlerName | undefined {
	if (
		typeof navigator === 'object' &&
		typeof navigator.userAgent === 'string'
	) {
		const ua = navigator.userAgent;

		const uaParser = new UAParser(ua);

		logger.debug('detectDevice() | browser detected [ua:%s, parsed:%o]', ua, uaParser.getResult());

		const browser = uaParser.getBrowser();
		const browserName = browser.name?.toLowerCase();
		const browserVersion = parseInt(browser.major ?? '0');
		const engine = uaParser.getEngine();
		const engineName = engine.name?.toLowerCase();
		const os = uaParser.getOS();
		const osName = os.name?.toLowerCase();
		const osVersion = parseFloat(os.version ?? '0');
		const device = uaParser.getDevice();
		const deviceModel = device.model?.toLowerCase();

		const isIOS = osName === 'ios' || deviceModel === 'ipad';

		const isChrome =
			browserName &&
			[
				'chrome',
				'chromium',
				'mobile chrome',
				'chrome webview',
				'chrome headless',
			].includes(browserName);

		const isFirefox =
			browserName &&
			[ 'firefox', 'mobile firefox', 'mobile focus' ].includes(browserName);

		const isSafari =
			browserName && [ 'safari', 'mobile safari' ].includes(browserName);

		const isEdge = browserName && [ 'edge' ].includes(browserName);

		if (
			(isChrome && !isIOS && browserVersion >= 74) ||
			(isEdge && !isIOS && browserVersion >= 88)
		) {
			return 'Chrome74';
		} else if (isFirefox && !isIOS && browserVersion >= 60) {
			return 'Firefox60';
		} else if (isFirefox && isIOS && osVersion >= 14.3) {
			return 'Safari12';
		} else if (
			isSafari &&
			browserVersion >= 12 &&
			typeof RTCRtpTransceiver !== 'undefined' &&
			RTCRtpTransceiver.prototype.hasOwnProperty('currentDirection')
		) {
			return 'Safari12';
		} else if (
			engineName === 'webkit' &&
			isIOS &&
			typeof RTCRtpTransceiver !== 'undefined' &&
			RTCRtpTransceiver.prototype.hasOwnProperty('currentDirection')
		) {
			return 'Safari12';
		} else if (engineName === 'blink') {
			return 'Chrome74';
		} else {
			logger.warn('detectDevice() | browser not supported [name:%s, version:%s]', browserName, browserVersion);

			return undefined;
		}
	} else {
		logger.warn('detectDevice() | unknown device');

		return undefined;
	}
}

export type DeviceObserverEvents = {
	newtransport: [Transport];
};

export class Device {
	private readonly _handlerFactory: HandlerFactory;
	private readonly _handlerName: string;
	private _loaded = false;
	private _extendedRtpCapabilities?: RtpCapabilities;
	private _recvRtpCapabilities?: RtpCapabilities;
	private readonly _canProduceByKind: CanProduceByKind;
	private _sctpCapabilities?: SctpCapabilities;
	protected readonly _observer = new EnhancedEventEmitter<DeviceObserverEvents>();

	private resolveReady!: () => void;
	public ready: Promise<void> = new Promise((resolve) => {
		this.resolveReady = resolve;
	});

	constructor({ handlerName, handlerFactory, Handler }: DeviceOptions = {}) {
		logger.debug('constructor()');

		// Handle deprecated option.
		if (Handler) {
			logger.warn('constructor() | Handler option is DEPRECATED, use handlerName or handlerFactory instead');

			if (typeof Handler === 'string') {
				handlerName = Handler as BuiltinHandlerName;
			} else {
				throw new TypeError('non string Handler option no longer supported, use handlerFactory instead');
			}
		}

		if (handlerName && handlerFactory) {
			throw new TypeError('just one of handlerName or handlerInterface can be given');
		}

		if (handlerFactory) {
			this._handlerFactory = handlerFactory;
		} else {
			if (handlerName) {
				logger.debug('constructor() | handler given: %s', handlerName);
			} else {
				handlerName = detectDevice();

				if (handlerName) {
					logger.debug('constructor() | detected handler: %s', handlerName);
				} else {
					throw new UnsupportedError('device not supported');
				}
			}

			switch (handlerName) {
				case 'Chrome74': {
					this._handlerFactory = Chrome74.createFactory();
					break;
				}

				case 'Firefox60': {
					this._handlerFactory = Firefox60.createFactory();
					break;
				}

				case 'Safari12': {
					this._handlerFactory = Safari12.createFactory();
					break;
				}

				default: {
					throw new TypeError(`unknown handlerName "${handlerName}"`);
				}
			}
		}

		// Create a temporal handler to get its name.
		const handler = this._handlerFactory();

		this._handlerName = handler.name;

		handler.close();

		this._extendedRtpCapabilities = undefined;
		this._recvRtpCapabilities = undefined;
		this._canProduceByKind = {
			audio: false,
			video: false,
		};
		this._sctpCapabilities = undefined;
	}

	get handlerName(): string {
		return this._handlerName;
	}

	get rtpCapabilities(): RtpCapabilities {
		if (!this._loaded) {
			throw new InvalidStateError('not loaded');
		}

		return this._recvRtpCapabilities!;
	}

	get sctpCapabilities(): SctpCapabilities {
		if (!this._loaded) {
			throw new InvalidStateError('not loaded');
		}

		return this._sctpCapabilities!;
	}

	get observer(): EnhancedEventEmitter {
		return this._observer;
	}

	async getRtpCapabilities(): Promise<RtpCapabilities> {
		logger.debug('getRtpCapabilities()');

		return this._handlerFactory().getNativeRtpCapabilities();
	}

	async load({ remoteRtpCapabilities }: { remoteRtpCapabilities: RtpCapabilities; }): Promise<void> {
		logger.debug('load() [remoteRtpCapabilities:%o]', remoteRtpCapabilities);

		remoteRtpCapabilities = utils.clone<RtpCapabilities>(remoteRtpCapabilities);

		// Temporal handler to get its capabilities.
		let handler: HandlerInterface | undefined;

		try {
			if (this._loaded) {
				throw new InvalidStateError('already loaded');
			}

			// This may throw.
			ortc.validateRtpCapabilities(remoteRtpCapabilities);

			handler = this._handlerFactory();

			const nativeRtpCapabilities = await handler.getNativeRtpCapabilities();

			logger.debug('load() | got native RTP capabilities:%o', nativeRtpCapabilities);

			// This may throw.
			ortc.validateRtpCapabilities(nativeRtpCapabilities);

			// Get extended RTP capabilities.
			this._extendedRtpCapabilities = ortc.getExtendedRtpCapabilities(nativeRtpCapabilities, remoteRtpCapabilities);

			logger.debug('load() | got extended RTP capabilities:%o', this._extendedRtpCapabilities);

			// Check whether we can produce audio/video.
			this._canProduceByKind.audio = ortc.canSend('audio', this._extendedRtpCapabilities);
			this._canProduceByKind.video = ortc.canSend('video', this._extendedRtpCapabilities);

			// Generate our receiving RTP capabilities for receiving media.
			this._recvRtpCapabilities = ortc.getRecvRtpCapabilities(this._extendedRtpCapabilities);

			// This may throw.
			ortc.validateRtpCapabilities(this._recvRtpCapabilities);

			logger.debug('load() | got receiving RTP capabilities:%o', this._recvRtpCapabilities);

			// Generate our SCTP capabilities.
			this._sctpCapabilities = await handler.getNativeSctpCapabilities();

			logger.debug('load() | got native SCTP capabilities:%o', this._sctpCapabilities);

			// This may throw.
			ortc.validateSctpCapabilities(this._sctpCapabilities);

			logger.debug('load() succeeded');

			this._loaded = true;

			handler.close();

			this.resolveReady();
		} catch (error) {
			if (handler) {
				handler.close();
			}

			throw error;
		}
	}

	canProduce(kind: MediaKind): boolean {
		if (!this._loaded) {
			throw new InvalidStateError('not loaded');
		} else if (kind !== 'audio' && kind !== 'video') {
			throw new TypeError(`invalid kind "${kind}"`);
		}

		return this._canProduceByKind[kind];
	}

	createSendTransport<TransportAppData extends AppData = AppData>({
		iceParameters,
		iceCandidates,
		dtlsParameters,
		sctpParameters,
		iceServers,
		iceTransportPolicy,
		additionalSettings,
		appData,
	}: TransportOptions<TransportAppData> = {}): Transport<TransportAppData> {
		logger.debug('createSendTransport()');

		return this.createTransport<TransportAppData>({
			direction: 'send',
			iceParameters,
			iceCandidates,
			dtlsParameters,
			sctpParameters,
			iceServers,
			iceTransportPolicy,
			additionalSettings,
			appData,
		});
	}

	createRecvTransport<TransportAppData extends AppData = AppData>({
		iceParameters,
		iceCandidates,
		dtlsParameters,
		sctpParameters,
		iceServers,
		iceTransportPolicy,
		additionalSettings,
		appData,
	}: TransportOptions<TransportAppData> = {}): Transport<TransportAppData> {
		logger.debug('createRecvTransport()');

		return this.createTransport<TransportAppData>({
			direction: 'recv',
			iceParameters,
			iceCandidates,
			dtlsParameters,
			sctpParameters,
			iceServers,
			iceTransportPolicy,
			additionalSettings,
			appData,
		});
	}

	private createTransport<TransportAppData extends AppData>({
		direction,
		iceParameters,
		iceCandidates,
		dtlsParameters,
		sctpParameters,
		iceServers,
		iceTransportPolicy,
		additionalSettings,
		appData,
	}: {
		direction: 'send' | 'recv';
	} & TransportOptions<TransportAppData>): Transport<TransportAppData> {
		if (!this._loaded) {
			throw new InvalidStateError('not loaded');
		} else if (iceParameters && typeof iceParameters !== 'object') {
			throw new TypeError('missing iceParameters');
		} else if (iceCandidates && !Array.isArray(iceCandidates)) {
			throw new TypeError('missing iceCandidates');
		} else if (dtlsParameters && typeof dtlsParameters !== 'object') {
			throw new TypeError('missing dtlsParameters');
		} else if (sctpParameters && typeof sctpParameters !== 'object') {
			throw new TypeError('wrong sctpParameters');
		} else if (appData && typeof appData !== 'object') {
			throw new TypeError('if given, appData must be an object');
		}

		// Create a new Transport.
		const transport = new Transport<TransportAppData>({
			direction,
			iceParameters,
			iceCandidates,
			dtlsParameters,
			sctpParameters,
			iceServers,
			iceTransportPolicy,
			additionalSettings,
			appData,
			handlerFactory: this._handlerFactory,
			extendedRtpCapabilities: this._extendedRtpCapabilities!,
			canProduceByKind: this._canProduceByKind,
		});

		// Emit observer event.
		this._observer.safeEmit('newtransport', transport);

		return transport;
	}
}
