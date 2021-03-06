/// <reference types="reflect-metadata" />

import { ZWaveError, ZWaveErrorCodes } from "@zwave-js/core";
import { MessageHeaders } from "@zwave-js/serial";
import { num2hex } from "@zwave-js/shared";
import type { JSONObject } from "@zwave-js/shared";
import { entries } from "alcalzone-shared/objects";
import { isCommandClassContainer } from "../commandclass/ICommandClassContainer";
import type { Driver } from "../driver/Driver";
import { getNodeTag, MessageOrCCLogEntry } from "../log/shared";
import { isNodeQuery } from "../node/INodeQuery";
import type { ZWaveNode } from "../node/Node";
import { FunctionType, MessagePriority, MessageType } from "./Constants";

type Constructable<T extends Message> = new (
	driver: Driver,
	options?: MessageOptions,
) => T;

export interface MessageDeserializationOptions {
	data: Buffer;
}

/**
 * Tests whether the given message constructor options contain a buffer for deserialization
 */
export function gotDeserializationOptions(
	options: Record<any, any> | undefined,
): options is MessageDeserializationOptions {
	return options != undefined && Buffer.isBuffer(options.data);
}

export interface MessageBaseOptions {
	callbackId?: number;
}

interface MessageCreationOptions extends MessageBaseOptions {
	type?: MessageType;
	functionType?: FunctionType;
	expectedResponse?: FunctionType | ResponsePredicate;
	payload?: Buffer;
}

export type MessageOptions =
	| MessageCreationOptions
	| MessageDeserializationOptions;

/**
 * Represents a Z-Wave message for communication with the serial interface
 */
export class Message {
	public constructor(protected driver: Driver, options: MessageOptions = {}) {
		// decide which implementation we follow
		if (gotDeserializationOptions(options)) {
			// #1: deserialize from payload
			const payload = options.data;

			// SOF, length, type, commandId and checksum must be present
			if (!payload.length || payload.length < 5) {
				throw new ZWaveError(
					"Could not deserialize the message because it was truncated",
					ZWaveErrorCodes.PacketFormat_Truncated,
				);
			}
			// the packet has to start with SOF
			if (payload[0] !== MessageHeaders.SOF) {
				throw new ZWaveError(
					"Could not deserialize the message because it does not start with SOF",
					ZWaveErrorCodes.PacketFormat_Invalid,
				);
			}
			// check the length again, this time with the transmitted length
			const messageLength = Message.getMessageLength(payload);
			if (payload.length < messageLength) {
				throw new ZWaveError(
					"Could not deserialize the message because it was truncated",
					ZWaveErrorCodes.PacketFormat_Truncated,
				);
			}
			// check the checksum
			const expectedChecksum = computeChecksum(
				payload.slice(0, messageLength),
			);
			if (payload[messageLength - 1] !== expectedChecksum) {
				throw new ZWaveError(
					"Could not deserialize the message because the checksum didn't match",
					ZWaveErrorCodes.PacketFormat_Checksum,
				);
			}

			this.type = payload[2];
			this.functionType = payload[3];
			const payloadLength = messageLength - 5;
			this.payload = payload.slice(4, 4 + payloadLength);

			// remember how many bytes were read
			this._bytesRead = messageLength;
		} else {
			// Try to determine the message type
			if (options.type == undefined) options.type = getMessageType(this);
			if (options.type == undefined) {
				throw new ZWaveError(
					"A message must have a given or predefined message type",
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			this.type = options.type;

			if (options.functionType == undefined)
				options.functionType = getFunctionType(this);
			if (options.functionType == undefined) {
				throw new ZWaveError(
					"A message must have a given or predefined function type",
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			this.functionType = options.functionType;

			// The expected response may be undefined
			this.expectedResponse =
				options.expectedResponse != undefined
					? options.expectedResponse
					: getExpectedResponse(this);

			this._callbackId = options.callbackId;

			this.payload = options.payload || Buffer.allocUnsafe(0);
		}
	}

	public type: MessageType;
	public functionType: FunctionType;
	public expectedResponse: FunctionType | ResponsePredicate | undefined;
	public payload: Buffer; // TODO: Length limit 255
	public maxSendAttempts: number | undefined;

	private _callbackId: number | undefined;
	/**
	 * Used to map requests to responses.
	 *
	 * WARNING: Accessing this property will generate a new callback ID if this message had none.
	 * If you want to compare the callback ID, use `hasCallbackId()` beforehand to check if the callback ID is already defined.
	 */
	public get callbackId(): number {
		if (this._callbackId == undefined) {
			this._callbackId = this.driver.getNextCallbackId();
		}
		return this._callbackId;
	}
	public set callbackId(v: number) {
		this._callbackId = v;
	}

	/**
	 * Tests whether this message's callback ID is defined
	 */
	public hasCallbackId(): boolean {
		return this._callbackId != undefined;
	}

	protected _bytesRead: number = 0;
	/**
	 * @internal
	 * The amount of bytes read while deserializing this message
	 */
	public get bytesRead(): number {
		return this._bytesRead;
	}

	/** Serializes this message into a Buffer */
	public serialize(): Buffer {
		const ret = Buffer.allocUnsafe(this.payload.length + 5);
		ret[0] = MessageHeaders.SOF;
		// length of the following data, including the checksum
		ret[1] = this.payload.length + 3;
		// write the remaining data
		ret[2] = this.type;
		ret[3] = this.functionType;
		this.payload.copy(ret, 4);
		// followed by the checksum
		ret[ret.length - 1] = computeChecksum(ret);
		return ret;
	}

	/** Returns the number of bytes the first message in the buffer occupies */
	public static getMessageLength(data: Buffer): number {
		const remainingLength = data[1];
		return remainingLength + 2;
	}

	/**
	 * Checks if there's enough data in the buffer to deserialize
	 */
	public static isComplete(data?: Buffer): boolean {
		if (!data || !data.length || data.length < 5) return false; // not yet

		const messageLength = Message.getMessageLength(data);
		if (data.length < messageLength) return false; // not yet

		return true; // probably, but the checksum may be wrong
	}

	/**
	 * Retrieves the correct constructor for the next message in the given Buffer.
	 * It is assumed that the buffer has been checked beforehand
	 */
	public static getConstructor(data: Buffer): Constructable<Message> {
		return getMessageConstructor(data[2], data[3]) || Message;
	}

	/** Creates an instance of the message that is serialized in the given buffer */
	public static from(driver: Driver, data: Buffer): Message {
		const Constructor = Message.getConstructor(data);
		const ret = new Constructor(driver, { data });
		return ret;
	}

	/** Returns the slice of data which represents the message payload */
	public static extractPayload(data: Buffer): Buffer {
		const messageLength = Message.getMessageLength(data);
		const payloadLength = messageLength - 5;
		return data.slice(4, 4 + payloadLength);
	}

	/** Generates a representation of this Message for the log */
	public toLogEntry(): MessageOrCCLogEntry {
		const tags = [
			this.type === MessageType.Request ? "REQ" : "RES",
			FunctionType[this.functionType],
		];
		const nodeId = this.getNodeId();
		if (nodeId) {
			tags.unshift(getNodeTag(nodeId));
		}
		return {
			tags,
			message:
				this.payload.length > 0
					? "payload: 0x" + this.payload.toString("hex")
					: undefined,
		};
	}

	/** Generates the JSON representation of this Message */
	public toJSON(): JSONObject {
		return this.toJSONInternal();
	}

	private toJSONInternal(): JSONObject {
		const ret: JSONObject = {
			name: this.constructor.name,
			type: MessageType[this.type],
			functionType:
				FunctionType[this.functionType] || num2hex(this.functionType),
		};
		if (this.expectedResponse != null)
			ret.expectedResponse = FunctionType[this.functionType];
		ret.payload = this.payload.toString("hex");
		return ret;
	}

	protected toJSONInherited(props: JSONObject): JSONObject {
		const ret = this.toJSONInternal();
		delete ret.payload;
		for (const [key, value] of entries(props)) {
			if (value !== undefined) ret[key] = value;
		}
		return ret;
	}

	/** Checks if a message is an expected response for this message */
	public testResponse(msg: Message): ResponseRole {
		// If a received request included a callback id, enforce that the response contains the same
		if (
			this.hasCallbackId() &&
			msg.type === MessageType.Request &&
			(!msg.hasCallbackId() || this._callbackId !== msg._callbackId)
		) {
			return "unexpected";
		}
		const expected = this.expectedResponse;
		// log("driver", `Message: testing response`, "debug");
		if (typeof expected === "number" && msg.type === MessageType.Response) {
			// if only a functionType was configured as expected,
			// any message with this function type is expected,
			// every other message is unexpected
			// log("driver", `  received response with fT ${msg.functionType}`, "debug");
			return expected === msg.functionType ? "final" : "unexpected";
		} else if (typeof expected === "function") {
			// If a predicate was configured, use it to test the message
			return expected(this, msg);
		}
		// nothing was configured, this expects no response
		return "unexpected";
	}

	/** Finds the ID of the target or source node in a message, if it contains that information */
	public getNodeId(): number | undefined {
		if (isNodeQuery(this)) return this.nodeId;
		if (isCommandClassContainer(this) && this.command.isSinglecast()) {
			return this.command.nodeId;
		}
	}

	/**
	 * Returns the node this message is linked to or undefined
	 */
	public getNodeUnsafe(): ZWaveNode | undefined {
		const nodeId = this.getNodeId();
		if (nodeId != undefined)
			return this.driver.controller.nodes.get(nodeId);
	}

	/** Include previously received partial responses into a final message */
	/* istanbul ignore next */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	public mergePartialMessages(partials: Message[]): void {
		// This is highly message dependent
		// Overwrite this in derived classes
		// By default it does nothing
	}
}

/** Computes the checksum for a serialized message as defined in the Z-Wave specs */
function computeChecksum(message: Buffer): number {
	let ret = 0xff;
	// exclude SOF and checksum byte from the computation
	for (let i = 1; i < message.length - 1; i++) {
		ret ^= message[i];
	}
	return ret;
}

// =======================
// use decorators to link function types to message classes
const METADATA_messageTypes = Symbol("messageTypes");
const METADATA_messageTypeMap = Symbol("messageTypeMap");
const METADATA_expectedResponse = Symbol("expectedResponse");
const METADATA_priority = Symbol("priority");

type MessageTypeMap = Map<string, Constructable<Message>>;
interface MessageTypeMapEntry {
	messageType: MessageType;
	functionType: FunctionType;
}

function getMessageTypeMapKey(
	messageType: MessageType,
	functionType: FunctionType,
): string {
	return JSON.stringify({ messageType, functionType });
}

export type ResponseRole =
	| "unexpected" // a message that does not belong to this transaction
	| "confirmation" // a confirmation response, e.g. controller reporting that a message was sent
	| "final" // a final response (leading to a resolved transaction)
	| "fatal_controller" // a response from the controller that leads to a rejected transaction
	| "fatal_node"; // a response or (lack thereof) from the node that leads to a rejected transaction
/**
 * A predicate function to test if a received message matches to the sent message
 */
export type ResponsePredicate = (
	sentMessage: Message,
	receivedMessage: Message,
) => ResponseRole;

/**
 * Defines the message and function type associated with a Z-Wave message
 */
export function messageTypes(
	messageType: MessageType,
	functionType: FunctionType,
): ClassDecorator {
	return (messageClass) => {
		Reflect.defineMetadata(
			METADATA_messageTypes,
			{ messageType, functionType },
			messageClass,
		);

		// also store a map in the Message metadata for lookup.
		const map: MessageTypeMap = (Reflect.getMetadata(
			METADATA_messageTypeMap,
			Message,
		) || new Map()) as MessageTypeMap;
		map.set(
			getMessageTypeMapKey(messageType, functionType),
			(messageClass as any) as Constructable<Message>,
		);
		Reflect.defineMetadata(METADATA_messageTypeMap, map, Message);
	};
}

/**
 * Retrieves the message type defined for a Z-Wave message class
 */
export function getMessageType<T extends Message>(
	messageClass: T,
): MessageType | undefined {
	// get the class constructor
	const constr = messageClass.constructor;
	// retrieve the current metadata
	const meta = Reflect.getMetadata(METADATA_messageTypes, constr) as
		| MessageTypeMapEntry
		| undefined;
	return meta?.messageType;
}

/**
 * Retrieves the message type defined for a Z-Wave message class
 */
export function getMessageTypeStatic<T extends Constructable<Message>>(
	classConstructor: T,
): MessageType | undefined {
	// retrieve the current metadata
	const meta = Reflect.getMetadata(
		METADATA_messageTypes,
		classConstructor,
	) as MessageTypeMapEntry | undefined;
	return meta?.messageType;
}

/**
 * Retrieves the function type defined for a Z-Wave message class
 */
export function getFunctionType<T extends Message>(
	messageClass: T,
): FunctionType | undefined {
	// get the class constructor
	const constr = messageClass.constructor;
	// retrieve the current metadata
	const meta = Reflect.getMetadata(METADATA_messageTypes, constr) as
		| MessageTypeMapEntry
		| undefined;
	return meta?.functionType;
}

/**
 * Retrieves the function type defined for a Z-Wave message class
 */
export function getFunctionTypeStatic<T extends Constructable<Message>>(
	classConstructor: T,
): FunctionType | undefined {
	// retrieve the current metadata
	const meta = Reflect.getMetadata(
		METADATA_messageTypes,
		classConstructor,
	) as MessageTypeMapEntry | undefined;
	return meta?.functionType;
}

/**
 * Looks up the message constructor for a given message type and function type
 */
function getMessageConstructor(
	messageType: MessageType,
	functionType: FunctionType,
): Constructable<Message> | undefined {
	// Retrieve the constructor map from the Message class
	const functionTypeMap = Reflect.getMetadata(
		METADATA_messageTypeMap,
		Message,
	) as MessageTypeMap | undefined;
	if (functionTypeMap != null) {
		return functionTypeMap.get(
			getMessageTypeMapKey(messageType, functionType),
		);
	}
}

/**
 * Defines the expected response associated with a Z-Wave message
 */
export function expectedResponse(type: FunctionType): ClassDecorator;
export function expectedResponse(predicate: ResponsePredicate): ClassDecorator;
export function expectedResponse(
	typeOrPredicate: FunctionType | ResponsePredicate,
): ClassDecorator {
	return (messageClass) => {
		Reflect.defineMetadata(
			METADATA_expectedResponse,
			typeOrPredicate,
			messageClass,
		);
	};
}

/**
 * Retrieves the expected response defined for a Z-Wave message class
 */
export function getExpectedResponse<T extends Message>(
	messageClass: T,
): FunctionType | ResponsePredicate | undefined {
	// get the class constructor
	const constr = messageClass.constructor;
	// retrieve the current metadata
	const ret = Reflect.getMetadata(METADATA_expectedResponse, constr) as
		| FunctionType
		| ResponsePredicate
		| undefined;
	return ret;
}

/**
 * Retrieves the function type defined for a Z-Wave message class
 */
export function getExpectedResponseStatic<T extends Constructable<Message>>(
	classConstructor: T,
): FunctionType | ResponsePredicate | undefined {
	// retrieve the current metadata
	const ret = Reflect.getMetadata(
		METADATA_expectedResponse,
		classConstructor,
	) as FunctionType | ResponsePredicate | undefined;
	return ret;
}

/**
 * Defines the default priority associated with a Z-Wave message
 */
export function priority(prio: MessagePriority): ClassDecorator {
	return (messageClass) => {
		Reflect.defineMetadata(METADATA_priority, prio, messageClass);
	};
}

/**
 * Retrieves the default priority defined for a Z-Wave message class
 */
export function getDefaultPriority<T extends Message>(
	messageClass: T,
): MessagePriority | undefined {
	// get the class constructor
	const constr = messageClass.constructor;
	// retrieve the current metadata
	const ret = Reflect.getMetadata(METADATA_priority, constr) as
		| MessagePriority
		| undefined;
	return ret;
}

/**
 * Retrieves the default priority defined for a Z-Wave message class
 */
export function getDefaultPriorityStatic<T extends Constructable<Message>>(
	classConstructor: T,
): MessagePriority | undefined {
	// retrieve the current metadata
	const ret = Reflect.getMetadata(METADATA_priority, classConstructor) as
		| MessagePriority
		| undefined;
	return ret;
}
