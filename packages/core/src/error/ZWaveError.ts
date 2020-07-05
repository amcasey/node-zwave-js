/**
 * Used to identify errors from this library without relying on the error message
 */
export enum ZWaveErrorCodes {
	PacketFormat_Truncated,
	PacketFormat_Invalid,
	PacketFormat_Checksum,
	// This differs from the above three. It means that the packet has a valid format and checksum,
	// but the data does not match the expectations. This error does not reset the Z-Wave stack
	PacketFormat_InvalidPayload,
	PacketFormat_DecryptionFailed,

	/** The driver failed to start */
	Driver_Failed,
	Driver_Reset,
	Driver_Destroyed,
	Driver_NotReady,
	Driver_InvalidDataReceived,
	Driver_NotSupported,
	Driver_NoPriority,
	Driver_InvalidCache,
	Driver_InvalidOptions,
	Driver_NoSecurity,

	/** The controller has timed out while waiting for a report from the node */
	Controller_Timeout,
	Controller_NodeTimeout,
	Controller_MessageDropped,
	Controller_ResponseNOK,
	Controller_CallbackNOK,
	Controller_InclusionFailed,
	Controller_ExclusionFailed,

	/** The node with the given node ID was not found */
	Controller_NodeNotFound,
	/** The endpoint with the given index was not found on the node */
	Controller_EndpointNotFound,
	/** The node was removed from the network */
	Controller_NodeRemoved,

	CC_Invalid,
	CC_NoNodeID,
	CC_NotSupported,
	CC_NotImplemented,
	CC_NoAPI,

	Deserialization_NotImplemented,
	Arithmetic,
	Argument_Invalid,

	Config_Invalid,

	// Here follow message specific errors
	/** The removal process could not be started or completed due to one or several reasons */
	RemoveFailedNode_Failed,
	/** The removal process was aborted because the node has responded */
	RemoveFailedNode_NodeOK,

	// Here follow CC specific errors

	/**
	 * Used to report the first existing parameter number
	 * available in a node's configuration
	 */
	ConfigurationCC_FirstParameterNumber = 1000,
	/**
	 * Used to report that a V3+ node should not have its parameters scanned with get/set commands
	 */
	ConfigurationCC_NoLegacyScanOnNewDevices,
	/**
	 * Used to report that a node using V3 or less MUST not use the resetToDefault flag
	 */
	ConfigurationCC_NoResetToDefaultOnLegacyDevices,

	/**
	 * Used to report that the command was not executed by the target node
	 */
	SupervisionCC_CommandFailed = 1100,

	/**
	 * Used to report that a ManufacturerProprietaryCC could not be instanciated
	 * because of a missing manufacturer ID.
	 */
	ManufacturerProprietaryCC_NoManufacturerId = 1200,

	/**
	 * Used to report that an invalid group ID was used to address a (Multi Channel) Association
	 */
	AssociationCC_InvalidGroup = 1300,
	/** Cannot add an association because it is not allowed */
	AssociationCC_NotAllowed,

	/** Used to report that no nonce exists */
	SecurityCC_NoNonce = 1400,

	/** The firmware update process is already active */
	FirmwareUpdateCC_Busy = 1500,
	/** The selected firmware target is not upgradable */
	FirmwareUpdateCC_NotUpgradable,
	/** The selected firmware target does not exist */
	FirmwareUpdateCC_TargetNotFound,
	/** The node reported that it could not start the update */
	FirmwareUpdateCC_FailedToStart,
	/** The node did not confirm the aborted update */
	FirmwareUpdateCC_FailedToAbort,
	/** The node did not confirm the completed update or the process stalled for too long */
	FirmwareUpdateCC_Timeout,
}

/**
 * Errors thrown in this libary are of this type. The `code` property identifies what went wrong.
 */
export class ZWaveError extends Error {
	public constructor(
		public readonly message: string,
		public readonly code: ZWaveErrorCodes,
	) {
		super(message);

		// We need to set the prototype explicitly
		Object.setPrototypeOf(this, ZWaveError.prototype);
	}
}
