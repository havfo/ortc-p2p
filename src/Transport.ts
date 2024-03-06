import { AwaitQueue } from 'awaitqueue';
import { v4 as uuidv4 } from 'uuid';
import queueMicrotask from 'queue-microtask';
import { Logger } from './Logger';
import { EnhancedEventEmitter } from './EnhancedEventEmitter';
import { UnsupportedError, InvalidStateError } from './errors';
import * as utils from './utils';
import * as ortc from './ortc';
import { HandlerFactory, HandlerInterface, HandlerReceiveOptions } from './handlers/HandlerInterface';
import { Producer, ProducerOptions } from './Producer';
import { Consumer, ConsumerOptions } from './Consumer';
import { DataProducer, DataProducerOptions } from './DataProducer';
import { DataConsumer, DataConsumerOptions } from './DataConsumer';
import { RtpParameters, MediaKind, RtpCapabilities } from './RtpParameters';
import { SctpParameters, SctpStreamParameters } from './SctpParameters';
import { AppData } from './types';

const logger = new Logger('Transport');

export type TransportOptions<TransportAppData extends AppData = AppData> = {
	iceParameters?: IceParameters;
	iceCandidates?: IceCandidate[];
	dtlsParameters?: DtlsParameters;
	sctpParameters?: SctpParameters;
	iceServers?: RTCIceServer[];
	iceTransportPolicy?: RTCIceTransportPolicy;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	additionalSettings?: any;
	appData?: TransportAppData;
};

export type CanProduceByKind = {
	audio: boolean;
	video: boolean;
	[key: string]: boolean;
};

export type IceParameters = {
	usernameFragment: string;
	password: string;
	iceLite?: boolean;
};

export type IceCandidate = {
	foundation: string;
	priority: number;
	address: string;
	ip: string;
	protocol: 'udp' | 'tcp';
	port: number;
	type: 'host' | 'srflx' | 'prflx' | 'relay';
	tcpType?: 'active' | 'passive' | 'so';
};

export type DtlsParameters = {
	role?: DtlsRole;
	fingerprints: DtlsFingerprint[];
};

export type FingerprintAlgorithm =
	| 'sha-1'
	| 'sha-224'
	| 'sha-256'
	| 'sha-384'
	| 'sha-512';

export type DtlsFingerprint = {
	type: FingerprintAlgorithm;
	hash: string;
};

export type DtlsRole = 'auto' | 'client' | 'server';

export type IceGatheringState = 'new' | 'gathering' | 'complete';

export type IceConnectionState = 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed';

export type PlainRtpParameters = {
	ip: string;
	ipVersion: 4 | 6;
	port: number;
};

export type TransportEvents = {
	connect: [ { dtlsParameters: DtlsParameters; iceParameters: IceParameters; }, () => void, (error: Error) => void ];
	icecandidate: [RTCIceCandidate | null];
	icegatheringstatechange: [IceGatheringState];
	iceconnectionstatechange: [IceConnectionState];
	produce: [ { id: string; kind: MediaKind; rtpParameters: RtpParameters; appData: AppData; } ];
	producedata: [ { sctpStreamParameters: SctpStreamParameters; label?: string; protocol?: string; appData: AppData; }, ({ id }: { id: string; }) => void, (error: Error) => void ];
};

export type TransportObserverEvents = {
	close: [];
	newproducer: [Producer];
	newconsumer: [Consumer];
	newdataproducer: [DataProducer];
	newdataconsumer: [DataConsumer];
};

class ConsumerCreationTask {
	consumerOptions: ConsumerOptions;
	promise: Promise<Consumer>;
	resolve?: (consumer: Consumer) => void;
	reject?: (error: Error) => void;

	constructor(consumerOptions: ConsumerOptions) {
		this.consumerOptions = consumerOptions;
		this.promise = new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

export class Transport<TransportAppData extends AppData = AppData> extends EnhancedEventEmitter<TransportEvents> {
	public readonly id: string;
	public closed = false;
	public readonly direction: 'send' | 'recv';
	public readonly extendedRtpCapabilities: RtpCapabilities;
	public readonly canProduceByKind: CanProduceByKind;
	public readonly maxSctpMessageSize?: number | null;
	public readonly handler: HandlerInterface;
	public iceGatheringState: IceGatheringState = 'new';
	public iceConnectionState: IceConnectionState = 'new';
	public appData: TransportAppData;
	private readonly _producers: Map<string, Producer> = new Map();
	private readonly _consumers: Map<string, Consumer> = new Map();
	private readonly _dataProducers: Map<string, DataProducer> = new Map();
	private readonly _dataConsumers: Map<string, DataConsumer> = new Map();
	private readonly _awaitQueue = new AwaitQueue();
	private _pendingConsumerTasks: ConsumerCreationTask[] = [];
	private _consumerCreationInProgress = false;
	private _pendingPauseConsumers: Map<string, Consumer> = new Map();
	private _consumerPauseInProgress = false;
	private _pendingResumeConsumers: Map<string, Consumer> = new Map();
	private _consumerResumeInProgress = false;
	private _pendingCloseConsumers: Map<string, Consumer> = new Map();
	private _consumerCloseInProgress = false;
	public readonly observer = new EnhancedEventEmitter<TransportObserverEvents>();

	constructor({
		direction,
		iceParameters,
		iceCandidates,
		dtlsParameters,
		sctpParameters,
		iceServers,
		iceTransportPolicy,
		additionalSettings,
		appData,
		handlerFactory,
		extendedRtpCapabilities,
		canProduceByKind,
	}: {
		direction: 'send' | 'recv';
		handlerFactory: HandlerFactory;
		extendedRtpCapabilities: RtpCapabilities;
		canProduceByKind: CanProduceByKind;
	} & TransportOptions<TransportAppData>) {
		super();

		logger.debug('constructor() [direction:%s]', direction);

		this.id = uuidv4();
		this.direction = direction;
		this.extendedRtpCapabilities = extendedRtpCapabilities;
		this.canProduceByKind = canProduceByKind;
		this.maxSctpMessageSize = sctpParameters ? sctpParameters.maxMessageSize : null;

		// Clone and sanitize additionalSettings.
		additionalSettings = utils.clone(additionalSettings) || {};

		delete additionalSettings.iceServers;
		delete additionalSettings.iceTransportPolicy;
		delete additionalSettings.bundlePolicy;
		delete additionalSettings.rtcpMuxPolicy;
		delete additionalSettings.sdpSemantics;

		this.handler = handlerFactory();

		this.handler.run({
			direction,
			iceParameters,
			iceCandidates,
			dtlsParameters,
			sctpParameters,
			iceServers,
			iceTransportPolicy,
			additionalSettings,
			extendedRtpCapabilities,
		});

		this.appData = appData || ({} as TransportAppData);

		this.handleHandler();
	}

	/**
	 * Close the Transport.
	 */
	close(): void {
		if (this.closed) {
			return;
		}

		logger.debug('close()');

		this.closed = true;

		// Stop the AwaitQueue.
		this._awaitQueue.stop();

		// Close the handler.
		this.handler.close();

		// Change connection state to 'closed' since the handler may not emit
		// '@connectionstatechange' event.
		this.iceConnectionState = 'closed';

		// Close all Producers.
		for (const producer of this._producers.values()) {
			producer.transportClosed();
		}
		this._producers.clear();

		// Close all Consumers.
		for (const consumer of this._consumers.values()) {
			consumer.transportClosed();
		}
		this._consumers.clear();

		// Close all DataProducers.
		for (const dataProducer of this._dataProducers.values()) {
			dataProducer.transportClosed();
		}
		this._dataProducers.clear();

		// Close all DataConsumers.
		for (const dataConsumer of this._dataConsumers.values()) {
			dataConsumer.transportClosed();
		}
		this._dataConsumers.clear();

		// Emit observer event.
		this.observer.safeEmit('close');
	}

	/**
	 * Get associated Transport (RTCPeerConnection) stats.
	 *
	 * @returns {RTCStatsReport}
	 */
	async getStats(): Promise<RTCStatsReport> {
		if (this.closed) {
			throw new InvalidStateError('closed');
		}

		return this.handler.getTransportStats();
	}

	/**
	 * Restart ICE connection.
	 */
	async restartIce({ iceParameters }: { iceParameters: IceParameters; }): Promise<void> {
		logger.debug('restartIce()');

		if (this.closed) {
			throw new InvalidStateError('closed');
		} else if (!iceParameters) {
			throw new TypeError('missing iceParameters');
		}

		// Enqueue command.
		return this._awaitQueue.push(async () => await this.handler.restartIce(iceParameters), 'transport.restartIce()');
	}

	/**
	 * Update ICE servers.
	 */
	async updateIceServers({ iceServers }: { iceServers?: RTCIceServer[] } = {}): Promise<void> {
		logger.debug('updateIceServers()');

		if (this.closed) {
			throw new InvalidStateError('closed');
		} else if (!Array.isArray(iceServers)) {
			throw new TypeError('missing iceServers');
		}

		// Enqueue command.
		return this._awaitQueue.push(async () => this.handler.updateIceServers(iceServers), 'transport.updateIceServers()');
	}

	/**
	 * Add a new ICE candidate from the remote endpoint.
	 */
	async addIceCandidate({ candidate }: { candidate: RTCIceCandidate | null; }): Promise<void> {
		logger.debug('addIceCandidate()');

		if (this.closed) {
			throw new InvalidStateError('closed');
		}

		// Enqueue command.
		return this._awaitQueue.push(async () => await this.handler.onRemoteIceCandidate(candidate), 'transport.addIceCandidate()');
	}

	/**
	 * Connect the Transport.
	 */
	async connect({ dtlsParameters, iceParameters }: { dtlsParameters: DtlsParameters; iceParameters: IceParameters; }): Promise<void> {
		logger.debug('connect()');

		if (this.closed) {
			throw new InvalidStateError('closed');
		} else if (!dtlsParameters) {
			throw new TypeError('missing dtlsParameters');
		} else if (!iceParameters) {
			throw new TypeError('missing iceParameters');
		}

		// Enqueue command.
		return this._awaitQueue.push(async () => await this.handler.connect({ dtlsParameters, iceParameters }), 'transport.connect()');
	}

	/**
	 * Create a Producer.
	 */
	async produce<ProducerAppData extends AppData = AppData>({
		track,
		codecOptions,
		codec,
		stopTracks = true,
		disableTrackOnPause = true,
		zeroRtpOnPause = false,
		appData = {} as ProducerAppData,
	}: ProducerOptions<ProducerAppData> = {}): Promise<Producer<ProducerAppData>> {
		logger.debug('produce() [track:%o]', track);

		if (this.closed) {
			throw new InvalidStateError('closed');
		} else if (!track) {
			throw new TypeError('missing track');
		} else if (this.direction !== 'send') {
			throw new UnsupportedError('not a sending Transport');
		} else if (!this.canProduceByKind[track.kind]) {
			throw new UnsupportedError(`cannot produce ${track.kind}`);
		} else if (track.readyState === 'ended') {
			throw new InvalidStateError('track ended');
		} else if (this.listenerCount('connect') === 0 && this.iceConnectionState === 'new') {
			throw new TypeError('no "connect" listener set into this transport');
		} else if (this.listenerCount('produce') === 0) {
			throw new TypeError('no "produce" listener set into this transport');
		} else if (appData && typeof appData !== 'object') {
			throw new TypeError('if given, appData must be an object');
		}

		// Enqueue command.
		return (
			this._awaitQueue
				.push(async () => {
					const { id, localId, rtpParameters, rtpSender } = await this.handler.send({ track, codecOptions, codec });

					try {
						// This will fill rtpParameters's missing fields with default values.
						ortc.validateRtpParameters(rtpParameters);

						this.safeEmit('produce', { id, kind: track.kind as MediaKind, rtpParameters, appData });

						const producer = new Producer<ProducerAppData>({
							id,
							localId,
							rtpSender,
							track,
							rtpParameters,
							stopTracks,
							disableTrackOnPause,
							zeroRtpOnPause,
							appData,
						});

						this._producers.set(producer.id, producer);
						this.handleProducer(producer);

						// Emit observer event.
						this.observer.safeEmit('newproducer', producer);

						return producer;
					} catch (error) {
						this.handler.stopSending(localId).catch(() => {});

						throw error;
					}
				}, 'transport.produce()')
				// This catch is needed to stop the given track if the command above
				// failed due to closed Transport.
				.catch((error: Error) => {
					if (stopTracks) {
						try {
							track.stop();
						} catch (error2) {}
					}

					throw error;
				})
		);
	}

	/**
	 * Create a Consumer to consume a remote Producer.
	 */
	async consume<ConsumerAppData extends AppData = AppData>({
		id,
		kind,
		rtpParameters,
		streamId,
		appData = {} as ConsumerAppData,
	}: ConsumerOptions<ConsumerAppData>): Promise<Consumer<ConsumerAppData>> {
		logger.debug('consume()');

		rtpParameters = utils.clone<RtpParameters>(rtpParameters);

		if (this.closed) {
			throw new InvalidStateError('closed');
		} else if (this.direction !== 'recv') {
			throw new UnsupportedError('not a receiving Transport');
		} else if (typeof id !== 'string') {
			throw new TypeError('missing id');
		} else if (kind !== 'audio' && kind !== 'video') {
			throw new TypeError(`invalid kind '${kind}'`);
		} else if (this.listenerCount('connect') === 0 && this.iceConnectionState === 'new') {
			throw new TypeError('no "connect" listener set into this transport');
		} else if (appData && typeof appData !== 'object') {
			throw new TypeError('if given, appData must be an object');
		}

		// Ensure the device can consume it.
		const canConsume = ortc.canReceive(rtpParameters, this.extendedRtpCapabilities);

		if (!canConsume) {
			throw new UnsupportedError('cannot consume this Producer');
		}

		const consumerCreationTask = new ConsumerCreationTask({
			id,
			kind,
			rtpParameters,
			streamId,
			appData,
		});

		// Store the Consumer creation task.
		this._pendingConsumerTasks.push(consumerCreationTask);

		// There is no Consumer creation in progress, create it now.
		queueMicrotask(() => {
			if (this.closed) {
				return;
			}

			if (this._consumerCreationInProgress === false) {
				this.createPendingConsumers<ConsumerAppData>();
			}
		});

		return consumerCreationTask.promise as Promise<Consumer<ConsumerAppData>>;
	}

	/**
	 * Create a DataProducer
	 */
	async produceData<DataProducerAppData extends AppData = AppData>({
		ordered = true,
		maxPacketLifeTime,
		maxRetransmits,
		label = '',
		protocol = '',
		appData = {} as DataProducerAppData,
	}: DataProducerOptions<DataProducerAppData> = {}): Promise<DataProducer<DataProducerAppData>> {
		logger.debug('produceData()');

		if (this.closed) {
			throw new InvalidStateError('closed');
		} else if (this.direction !== 'send') {
			throw new UnsupportedError('not a sending Transport');
		} else if (!this.maxSctpMessageSize) {
			throw new UnsupportedError('SCTP not enabled by remote Transport');
		} else if (this.listenerCount('connect') === 0 && this.iceConnectionState === 'new') {
			throw new TypeError('no "connect" listener set into this transport');
		} else if (this.listenerCount('producedata') === 0) {
			throw new TypeError('no "producedata" listener set into this transport');
		} else if (appData && typeof appData !== 'object') {
			throw new TypeError('if given, appData must be an object');
		}

		if (maxPacketLifeTime || maxRetransmits) {
			ordered = false;
		}

		// Enqueue command.
		return this._awaitQueue.push(async () => {
			const { dataChannel, sctpStreamParameters } = await this.handler.sendDataChannel({ ordered, maxPacketLifeTime, maxRetransmits, label, protocol });

			// This will fill sctpStreamParameters's missing fields with default values.
			ortc.validateSctpStreamParameters(sctpStreamParameters);

			const { id } = await new Promise<{ id: string }>((resolve, reject) => {
				this.safeEmit('producedata', { sctpStreamParameters, label, protocol, appData }, resolve, reject);
			});

			const dataProducer = new DataProducer<DataProducerAppData>({ id, dataChannel, sctpStreamParameters, appData });

			this._dataProducers.set(dataProducer.id, dataProducer);
			this.handleDataProducer(dataProducer);

			// Emit observer event.
			this.observer.safeEmit('newdataproducer', dataProducer);

			return dataProducer;
		}, 'transport.produceData()');
	}

	/**
	 * Create a DataConsumer
	 */
	async consumeData<ConsumerAppData extends AppData = AppData>({
		id,
		dataProducerId,
		sctpStreamParameters,
		label = '',
		protocol = '',
		appData = {} as ConsumerAppData,
	}: DataConsumerOptions<ConsumerAppData>): Promise<DataConsumer<ConsumerAppData>> {
		logger.debug('consumeData()');

		sctpStreamParameters = utils.clone(sctpStreamParameters);

		if (this.closed) {
			throw new InvalidStateError('closed');
		} else if (this.direction !== 'recv') {
			throw new UnsupportedError('not a receiving Transport');
		} else if (!this.maxSctpMessageSize) {
			throw new UnsupportedError('SCTP not enabled by remote Transport');
		} else if (typeof id !== 'string') {
			throw new TypeError('missing id');
		} else if (typeof dataProducerId !== 'string') {
			throw new TypeError('missing dataProducerId');
		} else if (this.listenerCount('connect') === 0 && this.iceConnectionState === 'new') {
			throw new TypeError('no "connect" listener set into this transport');
		} else if (appData && typeof appData !== 'object') {
			throw new TypeError('if given, appData must be an object');
		}

		// This may throw.
		ortc.validateSctpStreamParameters(sctpStreamParameters);

		// Enqueue command.
		return this._awaitQueue.push(async () => {
			const { dataChannel } = await this.handler.receiveDataChannel({ sctpStreamParameters, label, protocol });

			const dataConsumer = new DataConsumer<ConsumerAppData>({
				id,
				dataProducerId,
				dataChannel,
				sctpStreamParameters,
				appData,
			});

			this._dataConsumers.set(dataConsumer.id, dataConsumer);
			this.handleDataConsumer(dataConsumer);

			// Emit observer event.
			this.observer.safeEmit('newdataconsumer', dataConsumer);

			return dataConsumer;
		}, 'transport.consumeData()');
	}

	// This method is guaranteed to never throw.
	private async createPendingConsumers<ConsumerAppData extends AppData>(): Promise<void> {
		this._consumerCreationInProgress = true;

		this._awaitQueue
			.push(async () => {
				if (this._pendingConsumerTasks.length === 0) {
					logger.debug('createPendingConsumers() | there is no Consumer to be created');

					return;
				}

				const pendingConsumerTasks = [ ...this._pendingConsumerTasks ];

				// Clear pending Consumer tasks.
				this._pendingConsumerTasks = [];

				// Fill options list.
				const optionsList: HandlerReceiveOptions[] = [];

				for (const task of pendingConsumerTasks) {
					const { id, kind, rtpParameters, streamId } = task.consumerOptions;

					optionsList.push({ trackId: id!, kind: kind as MediaKind, rtpParameters, streamId });
				}

				try {
					const results = await this.handler.receive(optionsList);

					for (let idx = 0; idx < results.length; ++idx) {
						const task = pendingConsumerTasks[idx];
						const result = results[idx];
						const { id, rtpParameters, appData } = task.consumerOptions;
						const { localId, rtpReceiver, track } = result;
						const consumer = new Consumer<ConsumerAppData>({
							id: id!,
							localId,
							rtpReceiver,
							track,
							rtpParameters,
							appData: appData as ConsumerAppData,
						});

						this._consumers.set(consumer.id, consumer);
						this.handleConsumer(consumer);

						// Emit observer event.
						this.observer.safeEmit('newconsumer', consumer);

						task.resolve!(consumer);
					}
				} catch (error) {
					for (const task of pendingConsumerTasks) {
						task.reject!(error as Error);
					}
				}
			}, 'transport.createPendingConsumers()')
			.then(() => {
				this._consumerCreationInProgress = false;

				// There are pending Consumer tasks, enqueue their creation.
				if (this._pendingConsumerTasks.length > 0) {
					this.createPendingConsumers<ConsumerAppData>();
				}
			})
			// NOTE: We only get here when the await queue is closed.
			.catch(() => {});
	}

	private pausePendingConsumers() {
		this._consumerPauseInProgress = true;

		this._awaitQueue
			.push(async () => {
				if (this._pendingPauseConsumers.size === 0) {
					logger.debug('pausePendingConsumers() | there is no Consumer to be paused');

					return;
				}

				const pendingPauseConsumers = Array.from(this._pendingPauseConsumers.values());

				// Clear pending pause Consumer map.
				this._pendingPauseConsumers.clear();

				try {
					const localIds = pendingPauseConsumers.map((consumer) => consumer.localId);

					await this.handler.pauseReceiving(localIds);
				} catch (error) {
					logger.error('pausePendingConsumers() | failed to pause Consumers:', error);
				}
			}, 'transport.pausePendingConsumers')
			.then(() => {
				this._consumerPauseInProgress = false;

				// There are pending Consumers to be paused, do it.
				if (this._pendingPauseConsumers.size > 0) {
					this.pausePendingConsumers();
				}
			})
			// NOTE: We only get here when the await queue is closed.
			.catch(() => {});
	}

	private resumePendingConsumers() {
		this._consumerResumeInProgress = true;

		this._awaitQueue
			.push(async () => {
				if (this._pendingResumeConsumers.size === 0) {
					logger.debug('resumePendingConsumers() | there is no Consumer to be resumed');

					return;
				}

				const pendingResumeConsumers = Array.from(this._pendingResumeConsumers.values());

				// Clear pending resume Consumer map.
				this._pendingResumeConsumers.clear();

				try {
					const localIds = pendingResumeConsumers.map((consumer) => consumer.localId);

					await this.handler.resumeReceiving(localIds);
				} catch (error) {
					logger.error('resumePendingConsumers() | failed to resume Consumers:', error);
				}
			}, 'transport.resumePendingConsumers')
			.then(() => {
				this._consumerResumeInProgress = false;

				// There are pending Consumer to be resumed, do it.
				if (this._pendingResumeConsumers.size > 0) {
					this.resumePendingConsumers();
				}
			})
			// NOTE: We only get here when the await queue is closed.
			.catch(() => {});
	}

	private closePendingConsumers() {
		this._consumerCloseInProgress = true;

		this._awaitQueue
			.push(async () => {
				if (this._pendingCloseConsumers.size === 0) {
					logger.debug('closePendingConsumers() | there is no Consumer to be closed');

					return;
				}

				const pendingCloseConsumers = Array.from(this._pendingCloseConsumers.values());

				// Clear pending close Consumer map.
				this._pendingCloseConsumers.clear();

				try {
					await this.handler.stopReceiving(pendingCloseConsumers.map((consumer) => consumer.localId));
				} catch (error) {
					logger.error('closePendingConsumers() | failed to close Consumers:', error);
				}
			}, 'transport.closePendingConsumers')
			.then(() => {
				this._consumerCloseInProgress = false;

				// There are pending Consumer to be resumed, do it.
				if (this._pendingCloseConsumers.size > 0) {
					this.closePendingConsumers();
				}
			})
			// NOTE: We only get here when the await queue is closed.
			.catch(() => {});
	}

	private handleHandler(): void {
		const handler = this.handler;

		handler.on('@connect', ({ dtlsParameters, iceParameters }: { dtlsParameters: DtlsParameters; iceParameters: IceParameters; }, callback: () => void, errback: (error: Error) => void) => {
			if (this.closed) {
				errback(new InvalidStateError('closed'));

				return;
			}

			this.safeEmit('connect', { dtlsParameters, iceParameters }, callback, errback);
		});

		handler.on('@icecandidate', (candidate) => {
			if (!this.closed) {
				this.safeEmit('icecandidate', candidate);
			}
		});

		handler.on('@icegatheringstatechange', (iceGatheringState: IceGatheringState) => {
			if (iceGatheringState === this.iceGatheringState) {
				return;
			}

			logger.debug('ICE gathering state changed to %s', iceGatheringState);

			this.iceGatheringState = iceGatheringState;

			if (!this.closed) {
				this.safeEmit('icegatheringstatechange', iceGatheringState);
			}
		});

		handler.on('@iceconnectionstatechange', (iceConnectionState: IceConnectionState) => {
			if (iceConnectionState === this.iceConnectionState) {
				return;
			}

			logger.debug('connection state changed to %s', iceConnectionState);

			this.iceConnectionState = iceConnectionState;

			if (!this.closed) {
				this.safeEmit('iceconnectionstatechange', iceConnectionState);
			}
		});
	}

	private handleProducer(producer: Producer): void {
		producer.on('@close', () => {
			this._producers.delete(producer.id);

			if (this.closed) {
				return;
			}

			this._awaitQueue
				.push(async () => await this.handler.stopSending(producer.localId), 'producer @close event')
				.catch((error: Error) => logger.warn('producer.close() failed:%o', error));
		});

		producer.on('@pause', (callback, errback) => {
			this._awaitQueue
				.push(async () => await this.handler.pauseSending(producer.localId), 'producer @pause event')
				.then(callback)
				.catch(errback);
		});

		producer.on('@resume', (callback, errback) => {
			this._awaitQueue
				.push(async () => await this.handler.resumeSending(producer.localId), 'producer @resume event')
				.then(callback)
				.catch(errback);
		});

		producer.on('@replacetrack', (track, callback, errback) => {
			this._awaitQueue
				.push(async () => await this.handler.replaceTrack(producer.localId, track), 'producer @replacetrack event')
				.then(callback)
				.catch(errback);
		});

		producer.on('@getstats', (callback, errback) => {
			if (this.closed) {
				return errback!(new InvalidStateError('closed'));
			}

			this.handler
				.getSenderStats(producer.localId)
				.then(callback)
				.catch(errback);
		});
	}

	private handleConsumer(consumer: Consumer): void {
		consumer.on('@close', () => {
			this._consumers.delete(consumer.id);
			this._pendingPauseConsumers.delete(consumer.id);
			this._pendingResumeConsumers.delete(consumer.id);

			if (this.closed) {
				return;
			}

			// Store the Consumer into the close list.
			this._pendingCloseConsumers.set(consumer.id, consumer);

			// There is no Consumer close in progress, do it now.
			if (this._consumerCloseInProgress === false) {
				this.closePendingConsumers();
			}
		});

		consumer.on('@pause', () => {
			// If Consumer is pending to be resumed, remove from pending resume list.
			if (this._pendingResumeConsumers.has(consumer.id)) {
				this._pendingResumeConsumers.delete(consumer.id);
			}

			// Store the Consumer into the pending list.
			this._pendingPauseConsumers.set(consumer.id, consumer);

			// There is no Consumer pause in progress, do it now.
			queueMicrotask(() => {
				if (this.closed) {
					return;
				}

				if (this._consumerPauseInProgress === false) {
					this.pausePendingConsumers();
				}
			});
		});

		consumer.on('@resume', () => {
			// If Consumer is pending to be paused, remove from pending pause list.
			if (this._pendingPauseConsumers.has(consumer.id)) {
				this._pendingPauseConsumers.delete(consumer.id);
			}

			// Store the Consumer into the pending list.
			this._pendingResumeConsumers.set(consumer.id, consumer);

			// There is no Consumer resume in progress, do it now.
			queueMicrotask(() => {
				if (this.closed) {
					return;
				}

				if (this._consumerResumeInProgress === false) {
					this.resumePendingConsumers();
				}
			});
		});

		consumer.on('@getstats', (callback, errback) => {
			if (this.closed) {
				return errback!(new InvalidStateError('closed'));
			}

			this.handler
				.getReceiverStats(consumer.localId)
				.then(callback)
				.catch(errback);
		});
	}

	private handleDataProducer(dataProducer: DataProducer): void {
		dataProducer.on('@close', () => this._dataProducers.delete(dataProducer.id));
	}

	private handleDataConsumer(dataConsumer: DataConsumer): void {
		dataConsumer.on('@close', () => this._dataConsumers.delete(dataConsumer.id));
	}
}
