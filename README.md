# ORTC-P2P

Typescript library for P2P communication using ORTC. It has roughly the same API as [mediasoup](https://mediasoup.org/) and is mostly based on the mediasoup-client library.

## Usage example

```typescript
import { Device } from 'ortc-p2p';

const device1 = new Device();
const device2 = new Device();

const device1Capabilities = await device1.getRtpCapabilities();
const device2Capabilities = await device2.getRtpCapabilities();

await device1.load({ remoteRtpCapabilities: device2Capabilities });
await device2.load({ remoteRtpCapabilities: device1Capabilities });

const sendTransport1 = device1.createSendTransport();
const sendTransport2 = device2.createSendTransport();
const recvTransport1 = device1.createRecvTransport();
const recvTransport2 = device2.createRecvTransport();

sendTransport1.on('icecandidate', (candidate) => recvTransport2.addIceCandidate({ candidate }));
sendTransport2.on('icecandidate', (candidate) => recvTransport1.addIceCandidate({ candidate }));
recvTransport1.on('icecandidate', (candidate) => sendTransport2.addIceCandidate({ candidate }));
recvTransport2.on('icecandidate', (candidate) => sendTransport1.addIceCandidate({ candidate }));

sendTransport1.on('connect', ({ dtlsParameters, iceParameters }, callback, errback) => {
	recvTransport2.connect({ dtlsParameters, iceParameters })
		.then(callback)
		.catch(errback);
});

sendTransport1.on('produce', async ({ id, kind, rtpParameters, appData }) => {
	const consumer1 = await recvTransport2.consume({ id, kind, rtpParameters, appData });
});

sendTransport2.on('connect', ({ dtlsParameters, iceParameters }, callback, errback) => {
	recvTransport1.connect({ dtlsParameters, iceParameters })
		.then(callback)
		.catch(errback);
});

sendTransport2.on('produce', async ({ id, kind, rtpParameters, appData }) => {
	const consumer2 = await recvTransport1.consume({ id, kind, rtpParameters, appData });
});

recvTransport1.on('connect', ({ dtlsParameters, iceParameters }, callback, errback) => {
	sendTransport2.connect({ dtlsParameters, iceParameters })
		.then(callback)
		.catch(errback);
});

recvTransport2.on('connect', ({ dtlsParameters, iceParameters }, callback, errback) => {
	sendTransport1.connect({ dtlsParameters, iceParameters })
		.then(callback)
		.catch(errback);
});

await sendTransport1.produce({ track });
await sendTransport2.produce({ track });
```

## License

[ISC](./LICENSE)
