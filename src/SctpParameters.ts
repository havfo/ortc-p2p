export type SctpCapabilities = {
	numStreams: NumSctpStreams;
};

export type NumSctpStreams = {
	OS: number;
	MIS: number;
};

export type SctpParameters = {
	port: number;
	OS: number;
	MIS: number;
	maxMessageSize: number;
};

export type SctpStreamParameters = {
	streamId?: number;
	ordered?: boolean;
	maxPacketLifeTime?: number;
	maxRetransmits?: number;
	label: string;
	protocol?: string;
};
