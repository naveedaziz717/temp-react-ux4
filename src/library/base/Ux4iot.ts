import { io, Socket } from 'socket.io-client';
import {
	InitializationOptions,
	isDevOptions,
	ConnectionUpdateFunction,
	MessageCallback,
	SubscriptionErrorCallback,
	GrantErrorCallback,
	GRANT_RESPONSES,
} from '../types';

import {
	DesiredPropertyGrantRequest,
	DirectMethodGrantRequest,
	GrantRequest,
	IoTHubResponse,
	Message,
	SubscriptionRequest,
} from '../ux4iot-shared';

import { Ux4iotApi } from './Ux4iotApi';
import * as ux4iotState from './ux4iotState';
import {
	getGrantFromSubscriptionRequest,
	isConnectionStateMessage,
	isD2CMessage,
	isDeviceTwinMessage,
	isTelemetryMessage,
} from './utils';
import { DeviceMethodParams } from 'azure-iothub';
import { NETWORK_STATES, RECONNECT_TIMEOUT } from './constants';

export class Ux4iot {
	sessionId = '';
	socket: Socket | undefined;
	devMode: boolean;
	api: Ux4iotApi;
	retryTimeoutAfterError: NodeJS.Timeout;
	onSocketConnectionUpdate?: ConnectionUpdateFunction;
	onSessionId?: (sessionId: string) => void;

	constructor(
		options: InitializationOptions,
		onSessionId?: (sessionId: string) => void
	) {
		const { onSocketConnectionUpdate } = options;
		this.api = new Ux4iotApi(options);
		this.devMode = isDevOptions(options);
		this.onSocketConnectionUpdate = onSocketConnectionUpdate;
		this.onSessionId = onSessionId;
		this.connect();
	}

	private log(...args: any[]) {
		if (this.devMode) {
			console.warn('ux4iot:', ...args);
		}
	}

	private async connect(): Promise<void> {
		if (!this.socket) {
			try {
				const sessionId = await this.api.getSessionId();
				this.sessionId = sessionId;
			} catch (error) {
				const [reason, description] = NETWORK_STATES.UX4IOT_OFFLINE;
				this.log(reason, description, error);
				this.onSocketConnectionUpdate?.(reason, description);
				this.tryReconnect();
				return;
			}
			const socketURI = this.api.getSocketURL(this.sessionId);
			this.socket = io(socketURI);
			this.socket.on('connect', this.onConnect.bind(this));
			this.socket.on('connect_error', this.onConnectError.bind(this));
			this.socket.on('disconnect', this.onDisconnect.bind(this));
			this.socket.on('data', this.onData.bind(this));
		}
	}

	private tryReconnect() {
		clearTimeout(this.retryTimeoutAfterError as unknown as NodeJS.Timeout);
		this.retryTimeoutAfterError = setTimeout(
			this.connect.bind(this),
			RECONNECT_TIMEOUT
		);
	}

	private async onConnect() {
		this.log(`Connected to ${this.api.getSocketURL(this.sessionId)}`);
		this.log('Successfully reconnected. Resubscribing to old state...');
		this.api.setSessionId(this.sessionId);
		ux4iotState.resetState();
		this.onSessionId?.(this.sessionId); // this callback should be used to reestablish all subscriptions
		const [reason, description] = NETWORK_STATES.CONNECTED;
		this.onSocketConnectionUpdate?.(reason, description);
		clearTimeout(this.retryTimeoutAfterError as unknown as NodeJS.Timeout);
	}

	private onConnectError() {
		const socketURL = this.api.getSocketURL(this.sessionId);
		this.log(`Failed to establish websocket to ${socketURL}`);
		const [reason, description] = NETWORK_STATES.SERVER_UNAVAILABLE;
		this.onSocketConnectionUpdate?.(reason, description);
		this.tryReconnect();
	}

	private onDisconnect(error: unknown) {
		if (error === 'io client disconnect') {
			// https://socket.io/docs/v4/client-api/#event-disconnect
			const [reason, description] = NETWORK_STATES.CLIENT_DISCONNECTED;
			this.log(reason, description, error);
			this.onSocketConnectionUpdate?.(reason, description);
		} else {
			const [reason, description] = NETWORK_STATES.SERVER_DISCONNECTED;
			this.log(reason, description, error);
			this.onSocketConnectionUpdate?.(reason, description);
			this.socket = undefined;
			this.tryReconnect();
		}
	}

	public async destroy(): Promise<void> {
		this.socket?.disconnect();
		this.socket = undefined;
		clearTimeout(this.retryTimeoutAfterError as unknown as NodeJS.Timeout);
		this.log('socket with id', this.sessionId, 'destroyed');
	}

	private async onData(m: Message) {
		for (const subscriptions of Object.values(
			ux4iotState.state.subscriptions
		)) {
			for (const s of subscriptions) {
				const { type, deviceId } = s;
				if (deviceId === m.deviceId) {
					switch (type) {
						case 'telemetry': {
							if (isTelemetryMessage(m)) {
								const telemetry: Record<string, unknown> = {};
								for (const telemetryKey of s.telemetryKeys) {
									telemetry[telemetryKey] = m.telemetry[telemetryKey];
								}
								s.onData(m.deviceId, telemetry, m.timestamp);
							}
							break;
						}
						case 'connectionState':
							isConnectionStateMessage(m) &&
								s.onData(m.deviceId, m.connectionState, m.timestamp);
							break;
						case 'd2cMessages':
							isD2CMessage(m) && s.onData(m.deviceId, m.message, m.timestamp);
							break;
						case 'deviceTwin':
							isDeviceTwinMessage(m) &&
								s.onData(m.deviceId, m.deviceTwin, m.timestamp);
							break;
					}
				}
			}
		}
	}

	async unsubscribeAll() {
		for (const [subscriberId, subscriptions] of Object.entries(
			ux4iotState.state.subscriptions
		)) {
			for (const s of subscriptions) {
				const { onData, ...subscriptionRequest } = s;
				if (s.type === 'telemetry') {
					const { deviceId, type, telemetryKeys } = s;
					for (const telemetryKey of telemetryKeys) {
						const sr = {
							sessionId: this.sessionId,
							telemetryKey,
							deviceId,
							type,
						};
						await this.unsubscribe(subscriberId, sr);
					}
				} else {
					const sr = {
						...subscriptionRequest,
						sessionId: this.sessionId,
					} as SubscriptionRequest;
					await this.unsubscribe(subscriberId, sr);
				}
			}
		}
	}

	async patchDesiredProperties(
		grantRequest: Omit<DesiredPropertyGrantRequest, 'sessionId'>,
		desiredPropertyPatch: Record<string, unknown>,
		onGrantError?: GrantErrorCallback
	): Promise<IoTHubResponse | void> {
		const grantReq = { ...grantRequest, sessionId: this.sessionId };
		await this.grant(grantReq, onGrantError);
		await this.api.patchDesiredProperties(
			grantRequest.deviceId,
			desiredPropertyPatch
		);
	}

	async invokeDirectMethod(
		grantRequest: Omit<DirectMethodGrantRequest, 'sessionId'>,
		options: DeviceMethodParams,
		onGrantError?: GrantErrorCallback
	): Promise<IoTHubResponse | void> {
		const grantReq = { ...grantRequest, sessionId: this.sessionId };
		await this.grant(grantReq, onGrantError);
		return await this.api.invokeDirectMethod(grantRequest.deviceId, options);
	}

	async grant(grantRequest: GrantRequest, onGrantError?: GrantErrorCallback) {
		if (ux4iotState.hasGrant(grantRequest)) {
			return;
		}
		const grantResponse = await this.api.requestGrant(grantRequest);
		if (grantResponse === GRANT_RESPONSES.GRANTED) {
			ux4iotState.addGrant(grantRequest);
		} else {
			onGrantError?.(grantResponse);
		}
	}

	async subscribe(
		subscriberId: string,
		subscriptionRequest: Omit<SubscriptionRequest, 'sessionId'>,
		onData: MessageCallback,
		onSubscriptionError?: SubscriptionErrorCallback,
		onGrantError?: GrantErrorCallback
	) {
		const sr = {
			...subscriptionRequest,
			sessionId: this.sessionId,
		} as SubscriptionRequest;
		const grantRequest = getGrantFromSubscriptionRequest(sr);
		await this.grant(grantRequest, onGrantError);
		if (ux4iotState.hasGrant(grantRequest)) {
			try {
				const response = await this.getLastValueForSubscriptionRequest(sr);
				onData(response.deviceId, response.data, response.timestamp);
				// this if block is used as an optimization.
				// When the number of subscribers is bigger than 0 then we do not need to fire a subscription request
				// If the request fails, then we do not need to remove the subscription, since it will only be added after
				// the subscribe request is successful
				// If the number of subscribers isn't 0 then we know that the request succeeded in the past
				if (ux4iotState.getNumberOfSubscribers(sr) === 0) {
					await this.api.subscribe(subscriptionRequest);
				}
				ux4iotState.addSubscription(subscriberId, sr, onData);
			} catch (error) {
				onSubscriptionError?.(error.response?.data);
			}
		} else {
			onSubscriptionError?.('No grant for subscription');
		}
	}

	async unsubscribe(
		subscriberId: string,
		subscriptionRequest: Omit<SubscriptionRequest, 'sessionId'>,
		onSubscriptionError?: SubscriptionErrorCallback,
		onGrantError?: GrantErrorCallback
	) {
		const sr = {
			...subscriptionRequest,
			sessionId: this.sessionId,
		} as SubscriptionRequest;
		const grantRequest = getGrantFromSubscriptionRequest(sr);
		await this.grant(grantRequest, onGrantError);
		if (ux4iotState.hasGrant(grantRequest)) {
			try {
				if (ux4iotState.getNumberOfSubscribers(sr) === 1) {
					await this.api.unsubscribe(subscriptionRequest);
				}
				ux4iotState.removeSubscription(subscriberId, sr);
			} catch (error) {
				onSubscriptionError?.(error);
			}
		} else {
			onSubscriptionError?.('No grant for subscription');
		}
	}

	hasSubscription(
		subscriberId: string,
		subscriptionRequest: SubscriptionRequest
	) {
		const sr = {
			...subscriptionRequest,
			sessionId: this.sessionId,
		} as SubscriptionRequest;
		return ux4iotState.hasSubscription(subscriberId, sr);
	}

	getSubscriberIdSubscriptions(subscriberId: string): Record<string, string[]> {
		const registered = ux4iotState.state.subscriptions[subscriberId];
		const subscriptions: Record<string, string[]> = {};

		if (registered) {
			for (const s of registered) {
				if (s.type === 'telemetry') {
					subscriptions[s.deviceId] = s.telemetryKeys;
				} else {
					subscriptions[s.deviceId] = [];
				}
			}
		}
		return subscriptions;
	}

	async removeSubscriberId(subscriberId: string) {
		const subscriptions = ux4iotState.state.subscriptions[subscriberId];

		if (subscriptions) {
			for (const s of subscriptions) {
				try {
					if (s.type === 'telemetry') {
						for (const telemetryKey of s.telemetryKeys) {
							const sr = { type: s.type, deviceId: s.deviceId, telemetryKey };
							await this.unsubscribe(subscriberId, sr);
						}
					} else {
						await this.unsubscribe(subscriberId, s);
					}
				} catch (error) {
					console.warn('couldnt unsubscribe subscriberId', subscriberId, error);
				}
			}
		}
		ux4iotState.cleanSubId(subscriberId);
	}

	async getLastValueForSubscriptionRequest(
		subscriptionRequest: SubscriptionRequest
	): Promise<{ deviceId: string; data: any; timestamp: string }> {
		const { type, deviceId } = subscriptionRequest;
		switch (type) {
			case 'connectionState':
				return await this.api.getLastConnectionState(deviceId);
			case 'deviceTwin':
				return await this.api.getLastDeviceTwin(deviceId);
			case 'telemetry': {
				const { telemetryKey } = subscriptionRequest;
				return await this.api.getLastTelemetryValues(deviceId, telemetryKey);
			}
			case 'd2cMessages':
				return Promise.resolve({ deviceId, data: {}, timestamp: '' });
			default:
				return Promise.resolve({ deviceId, data: {}, timestamp: '' });
		}
	}
}
