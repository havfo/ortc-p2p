import { Logger } from './Logger';
import { EnhancedEventEmitter } from './EnhancedEventEmitter';
import { InvalidStateError } from './errors';
import { MediaKind, RtpCodecCapability, RtpParameters } from './RtpParameters';
import { AppData } from './types';

const logger = new Logger('Producer');

export type ProducerOptions<ProducerAppData extends AppData = AppData> = {
	track?: MediaStreamTrack;
	codecOptions?: ProducerCodecOptions;
	codec?: RtpCodecCapability;
	stopTracks?: boolean;
	disableTrackOnPause?: boolean;
	zeroRtpOnPause?: boolean;
	appData?: ProducerAppData;
};

export type ProducerCodecOptions = {
	opusStereo?: boolean;
	opusFec?: boolean;
	opusDtx?: boolean;
	opusMaxPlaybackRate?: number;
	opusMaxAverageBitrate?: number;
	opusPtime?: number;
	opusNack?: boolean;
	videoGoogleStartBitrate?: number;
	videoGoogleMaxBitrate?: number;
	videoGoogleMinBitrate?: number;
};

export type ProducerEvents = {
	transportclose: [];
	trackended: [];
	// Private events.
	'@pause': [() => void, (error: Error) => void];
	'@resume': [() => void, (error: Error) => void];
	'@replacetrack': [MediaStreamTrack | null, () => void, (error: Error) => void];
	'@getstats': [(stats: RTCStatsReport) => void, (error: Error) => void];
	'@close': [];
};

export type ProducerObserverEvents = {
	close: [];
	pause: [];
	resume: [];
	trackended: [];
};

export class Producer<ProducerAppData extends AppData = AppData> extends EnhancedEventEmitter<ProducerEvents> {
	public readonly id: string;
	public readonly localId: string;
	public closed = false;
	public readonly rtpSender?: RTCRtpSender;
	public track: MediaStreamTrack | null;
	public readonly kind: MediaKind;
	public readonly rtpParameters: RtpParameters;
	public paused: boolean;
	public stopTracks: boolean;
	public disableTrackOnPause: boolean;
	public zeroRtpOnPause: boolean;
	public appData: ProducerAppData;
	public readonly observer = new EnhancedEventEmitter<ProducerObserverEvents>();

	constructor({
		id,
		localId,
		rtpSender,
		track,
		rtpParameters,
		stopTracks,
		disableTrackOnPause,
		zeroRtpOnPause,
		appData,
	}: {
		id: string;
		localId: string;
		rtpSender?: RTCRtpSender;
		track: MediaStreamTrack;
		rtpParameters: RtpParameters;
		stopTracks: boolean;
		disableTrackOnPause: boolean;
		zeroRtpOnPause: boolean;
		appData?: ProducerAppData;
	}) {
		super();

		logger.debug('constructor()');

		this.id = id;
		this.localId = localId;
		this.rtpSender = rtpSender;
		this.track = track;
		this.kind = track.kind as MediaKind;
		this.rtpParameters = rtpParameters;
		this.paused = disableTrackOnPause ? !track.enabled : false;
		this.stopTracks = stopTracks;
		this.disableTrackOnPause = disableTrackOnPause;
		this.zeroRtpOnPause = zeroRtpOnPause;
		this.appData = appData || ({} as ProducerAppData);
		this.onTrackEnded = this.onTrackEnded.bind(this);

		this.handleTrack();
	}

	/**
	 * Closes the Producer.
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
	 * Get associated RTCRtpSender stats.
	 */
	async getStats(): Promise<RTCStatsReport> {
		if (this.closed) {
			throw new InvalidStateError('closed');
		}

		return new Promise<RTCStatsReport>((resolve, reject) => this.safeEmit('@getstats', resolve, reject));
	}

	/**
	 * Pauses sending media.
	 */
	pause(): void {
		logger.debug('pause()');

		if (this.closed) {
			return logger.error('pause() | Producer closed');
		}

		this.paused = true;

		if (this.track && this.disableTrackOnPause) {
			this.track.enabled = false;
		}

		if (this.zeroRtpOnPause) {
			new Promise<void>((resolve, reject) => this.safeEmit('@pause', resolve, reject)).catch(() => { });
		}

		this.observer.safeEmit('pause');
	}

	/**
	 * Resumes sending media.
	 */
	resume(): void {
		logger.debug('resume()');

		if (this.closed) {
			return logger.error('resume() | Producer closed');
		}

		this.paused = false;

		if (this.track && this.disableTrackOnPause) {
			this.track.enabled = true;
		}

		if (this.zeroRtpOnPause) {
			new Promise<void>((resolve, reject) => this.safeEmit('@resume', resolve, reject)).catch(() => { });
		}

		this.observer.safeEmit('resume');
	}

	/**
	 * Replaces the current track with a new one or null.
	 */
	async replaceTrack({ track }: { track: MediaStreamTrack | null; }): Promise<void> {
		logger.debug('replaceTrack() [track:%o]', track);

		if (this.closed) {
			if (track && this.stopTracks) {
				try {
					track.stop();
				} catch (error) { }
			}

			throw new InvalidStateError('closed');
		} else if (track && track.readyState === 'ended') {
			throw new InvalidStateError('track ended');
		}

		if (track === this.track) {
			return logger.debug('replaceTrack() | same track, ignored');
		}

		await new Promise<void>((resolve, reject) => this.safeEmit('@replacetrack', track, resolve, reject));

		this.destroyTrack();
		this.track = track;

		if (this.track && this.disableTrackOnPause) {
			this.track.enabled = !this.paused;
		}

		this.handleTrack();
	}

	private onTrackEnded(): void {
		logger.debug('track "ended" event');

		this.safeEmit('trackended');
		this.observer.safeEmit('trackended');
	}

	private handleTrack(): void {
		if (!this.track) {
			return;
		}

		this.track.addEventListener('ended', this.onTrackEnded);
	}

	private destroyTrack(): void {
		if (!this.track) {
			return;
		}

		try {
			this.track.removeEventListener('ended', this.onTrackEnded);

			if (this.stopTracks) {
				this.track.stop();
			}
		} catch (error) { }
	}
}
