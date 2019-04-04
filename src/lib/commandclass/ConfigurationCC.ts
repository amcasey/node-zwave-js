import { IDriver } from "../driver/IDriver";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import { encodeBitMask, Maybe, parseBitMask } from "../values/Primitive";
import { ccValue, CommandClass, commandClass, CommandClasses, expectedCCResponse, implementedVersion } from "./CommandClass";

export enum ConfigurationCommand {
	Set = 0x04,
	Get = 0x05,
	Report = 0x06,
	BulkSet = 0x07,
	BulkGet = 0x08,
	BulkReport = 0x09,
	NameGet = 0x0A,
	NameReport = 0x0B,
	InfoGet = 0x0C,
	InfoReport = 0x0D,
	PropertiesGet = 0x0E,
	PropertiesReport = 0x0F,
	DefaultReset = 0x01, // TODO: Or is this 0x10???
}

export enum ValueFormat {
	SignedInteger = 0x00,
	UnsignedInteger = 0x01,
	Enumerated = 0x02, // UnsignedInt, Radio Buttons
	BitField = 0x03, // Check Boxes
}

export interface ParameterInfo {
	minValue?: number;
	maxValue?: ConfigValue;
	defaultValue?: ConfigValue;
	valueSize?: number; // TODO: Use this
	format?: ValueFormat;
	name?: string;
	info?: string;
	noBulkSupport?: boolean;
	isAdvanced?: boolean;
	isReadonly?: boolean;
	requiresReInclusion?: boolean;
}

export type ConfigValue = number | Set<number>;

@commandClass(CommandClasses.Configuration)
@implementedVersion(4)
@expectedCCResponse(CommandClasses.Configuration)
export class ConfigurationCC extends CommandClass {

	// tslint:disable:unified-signatures
	constructor(
		driver: IDriver,
		nodeId?: number,
	);

	constructor(
		driver: IDriver,
		nodeId: number,
		ccCommand: ConfigurationCommand.Get | ConfigurationCommand.NameGet | ConfigurationCommand.InfoGet | ConfigurationCommand.PropertiesGet,
		parameter: number,
	);
	constructor(
		driver: IDriver,
		nodeId: number,
		ccCommand: ConfigurationCommand.Set,
		parameter: number, resetToDefault: boolean, valueSize?: number, value?: number,
	);
	constructor(
		driver: IDriver,
		nodeId: number,
		ccCommand: ConfigurationCommand.BulkSet,
		parameters: number[], resetToDefault: boolean, valueSize?: number, values?: number[], handshake?: boolean,
	);
	constructor(
		driver: IDriver,
		nodeId: number,
		ccCommand: ConfigurationCommand.BulkGet,
		parameters: number[],
	);

	constructor(
		driver: IDriver,
		public nodeId: number,
		public ccCommand?: ConfigurationCommand,
		...args: any[]
	) {
		super(driver, nodeId, ccCommand);
		if (
			this.ccCommand === ConfigurationCommand.Get
			|| this.ccCommand === ConfigurationCommand.NameGet
			|| this.ccCommand === ConfigurationCommand.InfoGet
			|| this.ccCommand === ConfigurationCommand.PropertiesGet
		) {
			this.parameter = args[0];
		} else if (this.ccCommand === ConfigurationCommand.Set) {
			[
				this.parameter,
				this.defaultFlag,
				this.valueSize,
				this.valueToSet,
			] = args;
		} else if (this.ccCommand === ConfigurationCommand.BulkSet) {
			let parameters: number[];
			let valuesToSet: ConfigValue[];
			[
				parameters,
				this.defaultFlag,
				this.valueSize,
				valuesToSet,
				this.handshake,
			] = args;
			if (!parameters || !valuesToSet || parameters.length < 1 || valuesToSet.length < 1) {
				throw new ZWaveError(
					`In a ConfigurationCC.BulkSet, parameters and valuesToSet must be non-empty arrays`,
					ZWaveErrorCodes.CC_Invalid,
				);
			}
			if (parameters.length !== valuesToSet.length) {
				throw new ZWaveError(
					`In a ConfigurationCC.BulkSet, parameters and valuesToSet must have the same size`,
					ZWaveErrorCodes.CC_Invalid,
				);
			}
			const combined = parameters
				.map((param, i) => [param, valuesToSet[i]] as [number, ConfigValue])
				.sort(([paramA], [paramB]) => paramA - paramB)
				;
			parameters = combined.map(([param]) => param);
			if (!isConsecutive(parameters)) {
				throw new ZWaveError(
					`A ConfigurationCC.BulkSet can only be used for consecutive parameters`,
					ZWaveErrorCodes.CC_Invalid,
				);
			}

			this.parameters = parameters;
			this.valuesToSet = combined.map(([, value]) => value);
		} else if (this.ccCommand === ConfigurationCommand.BulkGet) {
			this.parameters = args[0].sort();
			if (!isConsecutive(this.parameters)) {
				throw new ZWaveError(
					`A ConfigurationCC.BulkGet can only be used for consecutive parameters`,
					ZWaveErrorCodes.CC_Invalid,
				);
			}
		}
	}
	// tslint:enable:unified-signatures

	public defaultFlag: boolean;
	public handshake: boolean;
	public parameter: number;
	public valueToSet: ConfigValue;
	public valueSize: number;
	public parameters: number[];
	public valuesToSet: ConfigValue[];

	// TODO: Find a way to automatically update store those
	@ccValue() public values = new Map<number, ConfigValue>();
	@ccValue() public paramInformation = new Map<number, ParameterInfo>();

	private extendParamInformation(parameter: number, info: ParameterInfo) {
		if (!this.paramInformation.has(parameter)) {
			this.paramInformation.set(parameter, {});
		}
		Object.assign(this.paramInformation.get(parameter), info);
	}
	private getParamInformation(parameter: number) {
		return this.paramInformation.get(parameter) || {};
	}

	private _reportsToFollow: number;
	public get reportsToFollow(): number {
		return this._reportsToFollow;
	}

	private _nextParameter: number;
	public get nextParameter(): number {
		return this._nextParameter;
	}

	public supportsCommand(cmd: ConfigurationCommand): Maybe<boolean> {
		switch (cmd) {
			case ConfigurationCommand.Get:
			case ConfigurationCommand.Set:
				return true; // This is mandatory

			case ConfigurationCommand.BulkGet:
			case ConfigurationCommand.BulkSet:
				return this.version >= 2;

			case ConfigurationCommand.NameGet:
			case ConfigurationCommand.InfoGet:
			case ConfigurationCommand.PropertiesGet:
				return this.version >= 3;
		}
		return super.supportsCommand(cmd);
	}

	public serialize(): Buffer {
		switch (this.ccCommand) {
			case ConfigurationCommand.DefaultReset:
				// No payload
				break;

			case ConfigurationCommand.Set: {
				const valueSize = this.defaultFlag ? 1 : this.valueSize;
				const payloadLength = 2 + valueSize;
				this.payload = Buffer.alloc(payloadLength, 0);
				this.payload[0] = this.parameter;
				this.payload[1] = (this.defaultFlag ? 0b1000_0000 : 0) | (valueSize & 0b111);
				if (!this.defaultFlag) {
					serializeValue(
						this.payload, 2, valueSize,
						this.getParamInformation(this.parameter).format || ValueFormat.SignedInteger,
						this.valueToSet,
					);
				}
				break;
			}

			case ConfigurationCommand.Get:
				this.payload = Buffer.from([this.parameter & 0xff]);
				break;

			case ConfigurationCommand.BulkSet: {
				const valueSize = this.defaultFlag ? 1 : this.valueSize;
				const payloadLength = 4 + valueSize * this.parameters.length;
				this.payload = Buffer.alloc(payloadLength, 0);
				this.payload.writeUInt16BE(this.parameters[0], 0);
				this.payload[2] = this.parameters.length;
				this.payload[3] = (this.defaultFlag ? 0b1000_0000 : 0)
					| (this.handshake ? 0b0100_0000 : 0)
					| (valueSize & 0b111);
				if (!this.defaultFlag) {
					for (let i = 0; i < this.parameters.length; i++) {
						const param = this.parameters[i];
						serializeValue(
							this.payload, 4 + i * valueSize, valueSize,
							this.getParamInformation(param).format || ValueFormat.SignedInteger,
							this.valuesToSet[i],
						);
					}
				}
				break;
			}

			case ConfigurationCommand.BulkGet: {
				this.payload = Buffer.allocUnsafe(3);
				this.payload.writeUInt16BE(this.parameters[0], 0);
				this.payload[2] = this.parameters.length;
				break;
			}

			case ConfigurationCommand.NameGet:
			case ConfigurationCommand.InfoGet:
			case ConfigurationCommand.PropertiesGet: {
				this.payload = Buffer.allocUnsafe(2);
				this.payload.writeUInt16BE(this.parameter, 0);
				break;
			}

			default:
				throw new ZWaveError(
					"Cannot serialize a Configuration CC with a command other than Set, Get, BulkSet, BulkGet, NameGet, InfoGet, PropertiesGet or DefaultReset",
					ZWaveErrorCodes.CC_Invalid,
				);
		}

		return super.serialize();
	}

	public deserialize(data: Buffer): void {
		super.deserialize(data);

		switch (this.ccCommand) {
			case ConfigurationCommand.Report:
				this.parameter = this.payload[0];
				this.valueSize = this.payload[1] & 0b111;
				this.values.set(this.parameter, this.payload.readIntBE(2, this.valueSize));
				break;

			case ConfigurationCommand.BulkReport: {
				const firstParameter = this.payload.readUInt16BE(0);
				const numParams = this.payload[2];
				this._reportsToFollow = this.payload[3]; // TODO: Handle multiple reports
				this.defaultFlag = !!(this.payload[4] & 0b1000_0000);
				this.handshake = !!(this.payload[4] & 0b0100_0000);
				this.valueSize = this.payload[4] & 0b111;
				for (let i = 0; i < numParams; i++) {
					const param = firstParameter + i;
					this.values.set(param, parseValue(
						this.payload.slice(5 + i * this.valueSize),
						this.valueSize,
						this.getParamInformation(param).format || ValueFormat.SignedInteger,
					));
				}
				break;
			}

			case ConfigurationCommand.NameReport: {
				this.parameter = this.payload.readUInt16BE(0);
				this._reportsToFollow = this.payload[2];
				this.extendParamInformation(this.parameter, {
					name: (this.getParamInformation(this.parameter).name || "") + this.payload.slice(3).toString("utf8"),
				});
				break;
			}

			case ConfigurationCommand.InfoReport: {
				this.parameter = this.payload.readUInt16BE(0);
				this._reportsToFollow = this.payload[2];
				this.extendParamInformation(this.parameter, {
					info: (this.getParamInformation(this.parameter).info || "") + this.payload.slice(3).toString("utf8"),
				});
				break;
			}

			case ConfigurationCommand.PropertiesReport: {
				this.parameter = this.payload.readUInt16BE(0);
				const valueFormat = (this.payload[2] & 0b111000) >>> 3;
				this.extendParamInformation(this.parameter, {
					format: valueFormat,
					valueSize: this.payload[2] & 0b111,
				});
				if (this.valueSize > 0) {
					if (valueFormat !== ValueFormat.BitField) {
						this.extendParamInformation(this.parameter, {
							minValue: parseValue(this.payload.slice(3), this.valueSize, valueFormat) as number,
						});
					}
					this.extendParamInformation(this.parameter, {
						maxValue: parseValue(this.payload.slice(3 + this.valueSize), this.valueSize, valueFormat),
						defaultValue: parseValue(this.payload.slice(3 + 2 * this.valueSize), this.valueSize, valueFormat),
					});
				}
				if (this.version < 4) {
					// Read the last 2 bytes to work around nodes not omitting min/max value when their size is 0
					this._nextParameter = this.payload.readUInt16BE(this.payload.length - 2);
				} else {
					this._nextParameter = this.payload.readUInt16BE(3 + 3 * this.valueSize);

					const options1 = this.payload[2];
					const options2 = this.payload[3 + 3 * this.valueSize + 2];
					this.extendParamInformation(this.parameter, {
						requiresReInclusion: !!(options1 & 0b1000_0000),
						isReadonly: !!(options1 & 0b0100_0000),
						isAdvanced: !!(options2 & 0b1),
						noBulkSupport: !!(options2 & 0b10),
					});
				}
				break;
			}

			default:
				throw new ZWaveError(
					"Cannot deserialize a Configuration CC with a command other than Report, BulkReport, NameReport, InfoReport or PropertiesReport",
					ZWaveErrorCodes.CC_Invalid,
				);
		}
	}

}

/** Interprets values from the payload depending on the value format */
function parseValue(raw: Buffer, size: number, format: ValueFormat) {
	switch (format) {
		case ValueFormat.SignedInteger:
			return raw.readIntBE(0, size);
		case ValueFormat.UnsignedInteger:
		case ValueFormat.Enumerated:
			return raw.readUIntBE(0, size);
		case ValueFormat.BitField:
			return new Set(parseBitMask(raw.slice(0, size)));
	}
}

/** Serializes values into the payload according to the value format */
function serializeValue(payload: Buffer, offset: number, size: number, format: ValueFormat, value: ConfigValue) {
	switch (format) {
		case ValueFormat.SignedInteger:
			payload.writeIntBE(value as number, offset, size);
			return;
		case ValueFormat.UnsignedInteger:
		case ValueFormat.Enumerated:
			payload.writeUIntBE(value as number, offset, size);
			return;
		case ValueFormat.BitField: {
			const mask = encodeBitMask([...(value as Set<number>).values()], size * 8);
			mask.copy(payload, offset);
			return;
		}
	}
}

/** Ensures that the values array is consecutive */
function isConsecutive(values: number[]) {
	return values.every((v, i, arr) => i === 0 ? true : v - 1 === arr[i - 1]);
}