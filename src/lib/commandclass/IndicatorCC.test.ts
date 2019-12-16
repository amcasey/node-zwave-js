import { createEmptyMockDriver } from "../../../test/mocks";
import { loadIndicatorsInternal } from "../config/Indicators";
import { IDriver } from "../driver/IDriver";
import { ZWaveNode } from "../node/Node";
import { CommandClasses } from "./CommandClasses";
import {
	IndicatorCC,
	IndicatorCCGet,
	IndicatorCCReport,
	IndicatorCCSet,
	IndicatorCommand,
} from "./IndicatorCC";

function buildCCBuffer(nodeId: number, payload: Buffer): Buffer {
	return Buffer.concat([
		Buffer.from([
			nodeId, // node number
			payload.length + 1, // remaining length
			CommandClasses.Indicator, // CC
		]),
		payload,
	]);
}

describe("lib/commandclass/IndicatorCC => ", () => {
	let fakeDriver: IDriver;
	let node: ZWaveNode;

	beforeAll(async () => {
		fakeDriver = (createEmptyMockDriver() as unknown) as IDriver;
		node = new ZWaveNode(1, fakeDriver as any);
		(fakeDriver.controller.nodes as any).set(1, node);
		await loadIndicatorsInternal();
	});

	it("the Get command (V1) should serialize correctly", () => {
		const cc = new IndicatorCCGet(fakeDriver, { nodeId: 1 });
		const expected = buildCCBuffer(
			1,
			Buffer.from([
				IndicatorCommand.Get, // CC Command
			]),
		);
		expect(cc.serialize()).toEqual(expected);
	});

	it("the Get command (V2) should serialize correctly", () => {
		const cc = new IndicatorCCGet(fakeDriver, {
			nodeId: 1,
			indicatorId: 5,
		});
		const expected = buildCCBuffer(
			1,
			Buffer.from([
				IndicatorCommand.Get, // CC Command
				5,
			]),
		);
		expect(cc.serialize()).toEqual(expected);
	});

	it("the Set command (v1) should serialize correctly", () => {
		const cc = new IndicatorCCSet(fakeDriver, {
			nodeId: 2,
			value: 23,
		});
		const expected = buildCCBuffer(
			2,
			Buffer.from([
				IndicatorCommand.Set, // CC Command
				23, // value
			]),
		);
		expect(cc.serialize()).toEqual(expected);
	});

	it("the Set command (v2) should serialize correctly", () => {
		const cc = new IndicatorCCSet(fakeDriver, {
			nodeId: 2,
			values: [
				{
					indicatorId: 1,
					propertyId: 2,
					value: 3,
				},
				{
					indicatorId: 5,
					propertyId: 3,
					value: 1,
				},
			],
		});
		const expected = buildCCBuffer(
			2,
			Buffer.from([
				IndicatorCommand.Set, // CC Command
				0,
				2, // object count
				1, // indicatorId
				2, // propertyId
				3, // value
				5, // indicatorId
				3, // propertyId
				1, // value
			]),
		);
		expect(cc.serialize()).toEqual(expected);
	});

	it("the Report command (v1) should be deserialized correctly", () => {
		const ccData = buildCCBuffer(
			1,
			Buffer.from([
				IndicatorCommand.Report, // CC Command
				55, // value
			]),
		);
		const cc = new IndicatorCCReport(fakeDriver, { data: ccData });

		expect(cc.value).toBe(55);
		expect(cc.values).toBeUndefined();
	});

	it("the Report command (v2) should be deserialized correctly", () => {
		const ccData = buildCCBuffer(
			1,
			Buffer.from([
				IndicatorCommand.Report, // CC Command
				0,
				2, // object count
				1, // indicatorId
				2, // propertyId
				3, // value
				5, // indicatorId
				3, // propertyId
				1, // value
			]),
		);
		const cc = new IndicatorCCReport(fakeDriver, { data: ccData });

		expect(cc.value).toBe(undefined);
		expect(cc.values).toEqual([
			{
				indicatorId: 1,
				propertyId: 2,
				value: 3,
			},
			{
				indicatorId: 5,
				propertyId: 3,
				value: 1,
			},
		]);
	});

	it("deserializing an unsupported command should return an unspecified version of IndicatorCC", () => {
		const serializedCC = buildCCBuffer(
			1,
			Buffer.from([255]), // not a valid command
		);
		const cc: any = new IndicatorCC(fakeDriver, {
			data: serializedCC,
		});
		expect(cc.constructor).toBe(IndicatorCC);
	});

	// it("the CC values should have the correct metadata", () => {
	// 	// Readonly, 0-99
	// 	const currentValueMeta = getCCValueMetadata(
	// 		CommandClasses.Indicator,
	// 		"currentValue",
	// 	);
	// 	expect(currentValueMeta).toMatchObject({
	// 		readable: true,
	// 		writeable: false,
	// 		min: 0,
	// 		max: 99,
	// 	});

	// 	// Writeable, 0-99
	// 	const targetValueMeta = getCCValueMetadata(
	// 		CommandClasses.Indicator,
	// 		"targetValue",
	// 	);
	// 	expect(targetValueMeta).toMatchObject({
	// 		readable: true,
	// 		writeable: true,
	// 		min: 0,
	// 		max: 99,
	// 	});
	// });
});