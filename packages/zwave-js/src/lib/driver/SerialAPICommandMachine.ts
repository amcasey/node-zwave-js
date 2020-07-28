// wotan-disable no-uninferred-type-parameter

import { highResTimestamp } from "@zwave-js/core";
import { assign, Interpreter, Machine, StateMachine } from "xstate";
import { send } from "xstate/lib/actions";
import log from "../log";
import { MessageType } from "../message/Constants";
import type { Message } from "../message/Message";
import {
	isMultiStageCallback,
	isSuccessIndicator,
} from "../message/SuccessIndicator";
import {
	respondUnexpected,
	ServiceImplementations,
} from "./StateMachineShared";

/* eslint-disable @typescript-eslint/ban-types */
export interface SerialAPICommandStateSchema {
	states: {
		init: {};
		sending: {};
		waitForACK: {};
		waitForResponse: {};
		waitForCallback: {};
		retry: {};
		retryWait: {};
		failure: {};
		success: {};
	};
}
/* eslint-enable @typescript-eslint/ban-types */

export type SerialAPICommandError =
	| "send failure"
	| "CAN"
	| "NAK"
	| "ACK timeout"
	| "response timeout"
	| "callback timeout"
	| "response NOK"
	| "callback NOK";

export interface SerialAPICommandContext {
	msg: Message;
	data: Buffer;
	// msg: Buffer;
	expectsResponse: boolean;
	expectsCallback: boolean;
	attempts: number;
	maxAttempts: number;
	lastError?: SerialAPICommandError;
	result?: Message;
	txTimestamp?: number;
}

export type SerialAPICommandEvent =
	| { type: "ACK" }
	| { type: "CAN" }
	| { type: "NAK" }
	| { type: "message"; message: Message } // A message that might or might not be expected
	| { type: "response"; message: Message } // Gets forwarded when a response-type message is expected
	| { type: "callback"; message: Message } // Gets forwarded when a callback-type message is expected
	| { type: "serialAPIUnexpected"; message: Message }; // A message that IS unexpected on the Serial API level

export type SerialAPICommandDoneData =
	| {
			type: "success";
			txTimestamp: number;
			result: Message;
	  }
	| ({
			type: "failure";
	  } & (
			| {
					reason:
						| "send failure"
						| "CAN"
						| "NAK"
						| "ACK timeout"
						| "response timeout"
						| "callback timeout";
					result?: undefined;
			  }
			| {
					reason: "response NOK" | "callback NOK";
					result: Message;
			  }
	  ));

function computeRetryDelay(ctx: SerialAPICommandContext): number {
	return 100 + 1000 * (ctx.attempts - 1);
}

const forwardMessage = send((_, evt: SerialAPICommandEvent) => {
	const msg = (evt as any).message as Message;
	return {
		type: msg.type === MessageType.Response ? "response" : "callback",
		message: msg,
	} as SerialAPICommandEvent;
});

function logOutgoingMessage(ctx: SerialAPICommandContext) {
	log.driver.logMessage(ctx.msg, {
		direction: "outbound",
	});
}

export type SerialAPICommandMachine = StateMachine<
	SerialAPICommandContext,
	SerialAPICommandStateSchema,
	SerialAPICommandEvent
>;
export type SerialAPICommandInterpreter = Interpreter<
	SerialAPICommandContext,
	SerialAPICommandStateSchema,
	SerialAPICommandEvent
>;

export function createSerialAPICommandMachine(
	message: Message,
	{ sendData, notifyRetry }: ServiceImplementations,
	initialContext: Partial<SerialAPICommandContext> = {},
): SerialAPICommandMachine {
	return Machine<
		SerialAPICommandContext,
		SerialAPICommandStateSchema,
		SerialAPICommandEvent
	>(
		{
			id: "serialAPICommand",
			initial: "init",
			context: {
				msg: message,
				data: Buffer.from([]),
				expectsResponse: false,
				expectsCallback: false,
				attempts: 0,
				maxAttempts: 3,
				...initialContext,
			},
			on: {
				// The state machine accepts any message. If it is expected
				// it will be forwarded to the correct states. If not, it
				// will be returned with the "serialAPIUnexpected" event.
				message: [
					{
						cond: "isExpectedMessage",
						actions: forwardMessage as any,
					},
					{
						actions: respondUnexpected("serialAPIUnexpected"),
					},
				],
			},
			states: {
				// Extract the necessary data from the message instance and
				// start sending
				init: {
					entry: assign({
						data: (ctx) => ctx.msg.serialize(),
						expectsResponse: (ctx) => !!ctx.msg.expectedResponse,
						expectsCallback: (ctx) =>
							ctx.msg.hasCallbackId() &&
							ctx.msg.callbackId !== 0 &&
							!!ctx.msg.expectedCallback,
					}),
					always: "sending",
				},
				sending: {
					// Every send attempt should increase the attempts by one
					// and remember the timestamp of transmission
					entry: [
						assign({
							attempts: (ctx) => ctx.attempts + 1,
							txTimestamp: (_) => highResTimestamp(),
						}),
						logOutgoingMessage,
					],
					invoke: {
						id: "sendMessage",
						src: "send",
						onDone: "waitForACK",
						onError: {
							target: "retry",
							actions: assign({
								lastError: (_) => "send failure",
							}),
						},
					},
				},
				waitForACK: {
					on: {
						CAN: {
							target: "retry",
							actions: assign({
								lastError: (_) => "CAN",
							}),
						},
						NAK: {
							target: "retry",
							actions: assign({
								lastError: (_) => "NAK",
							}),
						},
						ACK: [
							{
								target: "waitForResponse",
							},
						],
					},
					after: {
						1600: {
							target: "retry",
							actions: assign({
								lastError: (_) => "ACK timeout",
							}),
						},
					},
				},
				waitForResponse: {
					always: [
						{
							target: "waitForCallback",
							cond: "expectsNoResponse",
						},
					],
					on: {
						response: [
							{
								target: "retry",
								cond: "responseIsNOK",
								actions: assign({
									lastError: (_) => "response NOK",
									result: (_, evt) => (evt as any).message,
								}),
							},
							{
								target: "waitForCallback",
								actions: assign({
									result: (_, evt) => (evt as any).message,
								}),
							},
						],
					},
					after: {
						1600: {
							target: "retry",
							actions: assign({
								lastError: (_) => "response timeout",
							}),
						},
					},
				},
				waitForCallback: {
					always: [{ target: "success", cond: "expectsNoCallback" }],
					on: {
						callback: [
							{
								target: "failure",
								cond: "callbackIsNOK",
								actions: assign({
									lastError: (_) => "callback NOK",
									result: (_, evt) => (evt as any).message,
								}),
							},
							{
								target: "success",
								cond: "callbackIsFinal",
								actions: assign({
									result: (_, evt) => (evt as any).message,
								}),
							},
							{ target: "waitForCallback" },
						],
					},
					after: {
						65000: {
							target: "failure",
							actions: assign({
								lastError: (_) => "callback timeout",
							}),
						},
					},
				},
				retry: {
					always: [
						{ target: "retryWait", cond: "mayRetry" },
						{ target: "failure" },
					],
				},
				retryWait: {
					invoke: {
						id: "notify",
						src: "notifyRetry",
					},
					after: {
						RETRY_DELAY: "sending",
					},
				},
				success: {
					type: "final",
					data: {
						type: "success",
						txTimestamp: (ctx: SerialAPICommandContext) =>
							ctx.txTimestamp!,
						result: (ctx: SerialAPICommandContext) => ctx.result!,
					},
				},
				failure: {
					type: "final",
					data: {
						type: "failure",
						reason: (ctx: SerialAPICommandContext) => ctx.lastError,
						result: (ctx: SerialAPICommandContext) => ctx.result!,
					},
				},
			},
		},
		{
			services: {
				send: (ctx) => sendData(ctx.data),
				notifyRetry: (ctx) => {
					notifyRetry?.(
						"SerialAPI",
						ctx.attempts,
						ctx.maxAttempts,
						computeRetryDelay(ctx),
					);
					return Promise.resolve();
				},
			},
			guards: {
				mayRetry: (ctx) => ctx.attempts < ctx.maxAttempts,
				expectsNoResponse: (ctx) => !ctx.expectsResponse,
				expectsNoCallback: (ctx) => !ctx.expectsCallback,
				isExpectedMessage: (ctx, evt, meta) =>
					meta.state.matches("waitForResponse")
						? ctx.msg.isExpectedResponse((evt as any).message)
						: meta.state.matches("waitForCallback")
						? ctx.msg.isExpectedCallback((evt as any).message)
						: false,
				responseIsNOK: (ctx, evt) =>
					evt.type === "response" &&
					// assume responses without success indication to be OK
					isSuccessIndicator(evt.message) &&
					!evt.message.isOK(),
				callbackIsNOK: (ctx, evt) =>
					evt.type === "callback" &&
					// assume callbacks without success indication to be OK
					isSuccessIndicator(evt.message) &&
					!evt.message.isOK(),
				callbackIsFinal: (ctx, evt) =>
					evt.type === "callback" &&
					// assume callbacks without success indication to be OK
					(!isSuccessIndicator(evt.message) || evt.message.isOK()) &&
					// assume callbacks without isFinal method to be final
					(!isMultiStageCallback(evt.message) ||
						evt.message.isFinal()),
			},
			delays: {
				RETRY_DELAY: (ctx) => computeRetryDelay(ctx),
			},
		},
	);
}