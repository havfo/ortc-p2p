import { Logger } from './Logger';
import { EnhancedEventEmitter } from './EnhancedEventEmitter';
import { InvalidStateError } from './errors';
import { MediaKind, RtpParameters } from './RtpParameters';
import { AppData } from './types';

const logger = new Logger('Consumer');

export type ConsumerOptions<ConsumerAppData extends AppData = AppData> = {
	id: string;
	kind: 'audio' | 'video';
	rtpParameters: RtpParameters;
	streamId?: string;
	appData?: ConsumerAppData;
};

export type ConsumerEvents = {
	transportclose: [];
	trackended: [];
	// eslint-disable-next-line no-unused-vars
	'@getstats': [(stats: RTCStatsReport) => void, (error: Error) => void];
	'@close': [];
	'@pause': [];
	'@resume': [];
};

export type ConsumerObserverEvents = {
	close: [];
	pause: [];
	resume: [];
	trackended: [];
};

export class Consumer<
	ConsumerAppData extends AppData = AppData,
> extends EnhancedEventEmitter<ConsumerEvents> {
	// Id.
	public readonly id: string;
	// Local id.
	public readonly localId: string;
	// Closed flag.
	public closed = false;
	// Associated RTCRtpReceiver.
	public readonly rtpReceiver?: RTCRtpReceiver;
	// Remote track.
	public readonly track: MediaStreamTrack;
	// RTP parameters.
	public readonly rtpParameters: RtpParameters;
	// Paused flag.
	public paused: boolean;
	// App custom data.
	public appData: ConsumerAppData;
	// Observer instance.
	public readonly observer = new EnhancedEventEmitter<ConsumerObserverEvents>();

	constructor({
		id,
		localId,
		rtpReceiver,
		track,
		rtpParameters,
		appData,
	}: {
		id: string;
		localId: string;
		rtpReceiver?: RTCRtpReceiver;
		track: MediaStreamTrack;
		rtpParameters: RtpParameters;
		appData?: ConsumerAppData;
	}) {
		super();

		logger.debug('constructor()');

		this.id = id;
		this.localId = localId;
		this.rtpReceiver = rtpReceiver;
		this.track = track;
		this.rtpParameters = rtpParameters;
		this.paused = !track.enabled;
		this.appData = appData || ({} as ConsumerAppData);
		this.onTrackEnded = this.onTrackEnded.bind(this);

		this.handleTrack();
	}

	/**
	 * Media kind.
	 */
	get kind(): MediaKind {
		return this.track.kind as MediaKind;
	}

	/**
	 * Closes the Consumer.
	 */
	close(): void {
		if (this.closed) {
			return;
		}

		logger.debug('close()');

		this.closed = true;

		this.destroyTrack();
		this.emit('@close');
		this.observer.safeEmit('close');
	}

	/**
	 * Transport was closed.
	 */
	transportClosed(): void {
		if (this.closed) {
			return;
		}

		logger.debug('transportClosed()');

		this.closed = true;

		this.destroyTrack();
		this.safeEmit('transportclose');
		this.observer.safeEmit('close');
	}

	/**
	 * Get associated RTCRtpReceiver stats.
	 */
	async getStats(): Promise<RTCStatsReport> {
		if (this.closed) {
			throw new InvalidStateError('closed');
		}

		return new Promise<RTCStatsReport>((resolve, reject) => this.safeEmit('@getstats', resolve, reject));
	}

	/**
	 * Pauses receiving media.
	 */
	pause(): void {
		logger.debug('pause()');

		if (this.closed) {
			return logger.error('pause() | Consumer closed');
		}

		if (this.paused) {
			return logger.debug('pause() | Consumer is already paused');
		}

		this.paused = true;
		this.track.enabled = false;

		this.emit('@pause');
		this.observer.safeEmit('pause');
	}

	/**
	 * Resumes receiving media.
	 */
	resume(): void {
		logger.debug('resume()');

		if (this.closed) {
			return logger.error('resume() | Consumer closed');
		}

		if (!this.paused) {
			return logger.debug('resume() | Consumer is already resumed');
		}

		this.paused = false;
		this.track.enabled = true;

		this.emit('@resume');
		this.observer.safeEmit('resume');
	}

	private onTrackEnded(): void {
		logger.debug('track "ended" event');

		this.safeEmit('trackended');
		this.observer.safeEmit('trackended');
	}

	private handleTrack(): void {
		this.track.addEventListener('ended', this.onTrackEnded);
	}

	private destroyTrack(): void {
		try {
			this.track.removeEventListener('ended', this.onTrackEnded);
			this.track.stop();
		} catch (error) { }
	}
}
