/**
 * parser.ts
 *
 * Parses raw Soroban event objects returned by the @stellar/stellar-sdk
 * SorobanRpc into typed ProofFeed events.
 *
 * ## Soroban event anatomy
 *
 * A raw event from SorobanRpc.Server.getEvents() has the shape:
 *
 *   {
 *     type: "contract",
 *     ledger: number,               // ledger sequence
 *     ledgerClosedAt: string,       // ISO timestamp
 *     contractId: string,           // "C..." strkey
 *     id: string,                   // event id
 *     pagingToken: string,
 *     inSuccessfulContractCall: boolean,
 *     txHash: string,
 *     topic: xdr.ScVal[],           // array of ScVal (decoded by SDK)
 *     value: xdr.ScVal,             // event body payload
 *   }
 *
 * The Soroban contract uses #[contractevent] which encodes the event name as
 * the first topic (a Symbol ScVal) and each field as additional topics or in
 * the value. Our contract puts the event name as the first topic.
 *
 * ## MVP approach
 *
 * For the MVP we use the SDK's built-in xdr helpers to extract Symbol strings
 * from topics and then decode the struct fields from the value ScVal.
 * Full production decoding would use the contract's ABI / generated bindings.
 *
 * TODO(prod): Replace manual XDR field extraction with auto-generated contract
 *   client bindings (stellar contract bindings) once they are stable.
 */

import { xdr } from '@stellar/stellar-sdk';
import {
  CreatorRegisteredEvent,
  PaymentRecordedEvent,
  SubscriptionCancelledEvent,
  SorobanEvent,
} from './types';

// ---------------------------------------------------------------------------
// Raw event shape from SorobanRpc (subset we care about)
// ---------------------------------------------------------------------------

/**
 * The subset of the SorobanRpc raw event response we use in the parser.
 * The SDK type is SorobanRpc.Api.EventResponse.
 */
export interface RawSorobanEvent {
  contractId: string;
  ledger: number;
  txHash: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

// ---------------------------------------------------------------------------
// Helpers for extracting ScVal fields
// ---------------------------------------------------------------------------

/**
 * Reads the string value from a Symbol ScVal.
 * Soroban event topics produced by #[contractevent] use ScSymbol for the
 * event name.
 *
 * TODO(prod): Add robust error handling / logging for unexpected ScVal types.
 */
function scValToSymbol(val: xdr.ScVal): string {
  // scvSymbol is a Buffer/Uint8Array of ASCII bytes
  if (val.switch().name === 'scvSymbol') {
    return val.sym().toString();
  }
  // Also handle string values
  if (val.switch().name === 'scvString') {
    return val.str().toString();
  }
  throw new Error(`Expected ScSymbol or ScString, got ${val.switch().name}`);
}

/**
 * Reads the string value from an Address ScVal (returns the strkey).
 *
 * TODO(prod): Use Address.contract() / Address.account() helpers from the SDK
 *   to handle both account and contract addresses correctly.
 */
function scValToAddress(val: xdr.ScVal): string {
  if (val.switch().name === 'scvAddress') {
    const addr = val.address();
    if (addr.switch().name === 'scAddressTypeAccount') {
      // AccountID → G... strkey
      return addr.accountId().publicKey().toString('base64'); // fallback
      // TODO(prod): Use StrKey.encodeEd25519PublicKey for proper G... format
    }
    if (addr.switch().name === 'scAddressTypeContract') {
      return addr.contractId().toString('hex');
      // TODO(prod): Use StrKey.encodeContract for proper C... format
    }
  }
  throw new Error(`Expected ScAddress, got ${val.switch().name}`);
}

/**
 * Reads an i128 or u64 from an ScVal as a JavaScript bigint.
 *
 * TODO(prod): Handle all numeric ScVal variants (scvI128, scvU64, scvU128,
 *   scvI64) explicitly with proper sign extension.
 */
function scValToBigInt(val: xdr.ScVal): bigint {
  const name = val.switch().name;
  if (name === 'scvI128') {
    const parts = val.i128();
    // hi is signed 64-bit, lo is unsigned 64-bit
    const hi = BigInt(parts.hi().toString());
    const lo = BigInt(parts.lo().toString());
    return (hi << 64n) | lo;
  }
  if (name === 'scvU64') {
    return BigInt(val.u64().toString());
  }
  if (name === 'scvU32') {
    return BigInt(val.u32());
  }
  if (name === 'scvI64') {
    return BigInt(val.i64().toString());
  }
  throw new Error(`Cannot convert ${name} to bigint`);
}

/**
 * Reads a u32 from an ScVal as a JavaScript number.
 */
function scValToU32(val: xdr.ScVal): number {
  if (val.switch().name === 'scvU32') {
    return val.u32();
  }
  throw new Error(`Expected scvU32, got ${val.switch().name}`);
}

/**
 * Reads a bool from an ScVal.
 */
function scValToBool(val: xdr.ScVal): boolean {
  if (val.switch().name === 'scvBool') {
    return val.b();
  }
  throw new Error(`Expected scvBool, got ${val.switch().name}`);
}

/**
 * Reads the map entries from a struct ScVal (scvMap).
 * Returns a Map from field name → ScVal.
 *
 * TODO(prod): Soroban #[contractevent] serialises struct fields as an ScMap
 *   with ScSymbol keys. This helper covers the MVP case.
 */
function scValToMap(val: xdr.ScVal): Map<string, xdr.ScVal> {
  if (val.switch().name !== 'scvMap') {
    throw new Error(`Expected scvMap, got ${val.switch().name}`);
  }
  const map = new Map<string, xdr.ScVal>();
  for (const entry of val.map() ?? []) {
    const key = scValToSymbol(entry.key());
    map.set(key, entry.val());
  }
  return map;
}

// ---------------------------------------------------------------------------
// Event name detection
// ---------------------------------------------------------------------------

/**
 * Extracts the event name from the first topic ScVal.
 * The Soroban #[contractevent] macro encodes the struct name as a Symbol in
 * the first topic.
 *
 * TODO(prod): Confirm topic layout with the actual compiled contract ABI.
 *   Some contract SDKs put the event name differently.
 */
function getEventName(topics: xdr.ScVal[]): string {
  if (topics.length === 0) {
    throw new Error('Event has no topics');
  }
  return scValToSymbol(topics[0]);
}

// ---------------------------------------------------------------------------
// Per-event parsers
// ---------------------------------------------------------------------------

/**
 * Parse a CreatorRegistered event body.
 *
 * Contract struct fields:
 *   creator:    Address
 *   tier_count: u32
 *
 * TODO(prod): Validate that field names match the serialised XDR keys from the
 *   compiled contract binary using stellar contract inspect output.
 */
function parseCreatorRegistered(
  raw: RawSorobanEvent,
  fields: Map<string, xdr.ScVal>
): CreatorRegisteredEvent {
  // TODO(prod): Full XDR decode using generated bindings.
  const creator = fields.get('creator');
  const tierCount = fields.get('tier_count');

  if (!creator || !tierCount) {
    throw new Error(
      `CreatorRegistered: missing fields. Got: ${[...fields.keys()].join(', ')}`
    );
  }

  return {
    contractId: raw.contractId,
    ledgerSequence: raw.ledger,
    transactionHash: raw.txHash,
    creator: scValToAddress(creator),
    tierCount: scValToU32(tierCount),
  };
}

/**
 * Parse a PaymentRecorded event body.
 *
 * Contract struct fields:
 *   subscriber:  Address
 *   creator:     Address
 *   amount:      i128
 *   timestamp:   u64
 *   is_renewal:  bool
 *
 * TODO(prod): Full XDR decode using generated bindings.
 */
function parsePaymentRecorded(
  raw: RawSorobanEvent,
  fields: Map<string, xdr.ScVal>
): PaymentRecordedEvent {
  const subscriber = fields.get('subscriber');
  const creator = fields.get('creator');
  const amount = fields.get('amount');
  const timestamp = fields.get('timestamp');
  const isRenewal = fields.get('is_renewal');

  if (!subscriber || !creator || !amount || !timestamp || isRenewal === undefined) {
    throw new Error(
      `PaymentRecorded: missing fields. Got: ${[...fields.keys()].join(', ')}`
    );
  }

  return {
    contractId: raw.contractId,
    ledgerSequence: raw.ledger,
    transactionHash: raw.txHash,
    subscriber: scValToAddress(subscriber),
    creator: scValToAddress(creator),
    amountStroops: scValToBigInt(amount),
    timestamp: scValToBigInt(timestamp),
    isRenewal: scValToBool(isRenewal),
  };
}

/**
 * Parse a SubscriptionCancelled event body.
 *
 * Contract struct fields:
 *   subscriber: Address
 *   creator:    Address
 *   timestamp:  u64
 *
 * TODO(prod): Full XDR decode using generated bindings.
 */
function parseSubscriptionCancelled(
  raw: RawSorobanEvent,
  fields: Map<string, xdr.ScVal>
): SubscriptionCancelledEvent {
  const subscriber = fields.get('subscriber');
  const creator = fields.get('creator');
  const timestamp = fields.get('timestamp');

  if (!subscriber || !creator || !timestamp) {
    throw new Error(
      `SubscriptionCancelled: missing fields. Got: ${[...fields.keys()].join(', ')}`
    );
  }

  return {
    contractId: raw.contractId,
    ledgerSequence: raw.ledger,
    transactionHash: raw.txHash,
    subscriber: scValToAddress(subscriber),
    creator: scValToAddress(creator),
    timestamp: scValToBigInt(timestamp),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses a raw Soroban event into a typed ProofFeed event.
 *
 * Returns null (with a warning log) for events that aren't one of the three
 * known ProofFeed event types, so the caller can safely skip unknown events
 * without crashing.
 *
 * @param raw — raw event object from SorobanRpc.Server.getEvents()
 */
export function parseEvent(raw: RawSorobanEvent): SorobanEvent | null {
  let eventName: string;
  try {
    eventName = getEventName(raw.topic);
  } catch (err) {
    console.warn(
      `[parser] Could not determine event name for tx ${raw.txHash}:`,
      err
    );
    return null;
  }

  // TODO(prod): The Soroban #[contractevent] macro may encode fields as
  //   additional topics rather than in the value ScVal depending on the SDK
  //   version. Confirm the layout via `stellar contract inspect` before
  //   deploying to mainnet.
  let fields: Map<string, xdr.ScVal>;
  try {
    fields = scValToMap(raw.value);
  } catch (err) {
    console.warn(
      `[parser] Could not parse event value as ScMap for tx ${raw.txHash}:`,
      err
    );
    return null;
  }

  try {
    switch (eventName) {
      case 'CreatorRegistered':
        return parseCreatorRegistered(raw, fields);
      case 'PaymentRecorded':
        return parsePaymentRecorded(raw, fields);
      case 'SubscriptionCancelled':
        return parseSubscriptionCancelled(raw, fields);
      default:
        // Unknown event type — skip silently. This is expected when the
        // contract emits events that don't belong to ProofFeed's schema.
        console.debug(`[parser] Skipping unknown event type: ${eventName}`);
        return null;
    }
  } catch (err) {
    console.error(
      `[parser] Failed to parse ${eventName} event from tx ${raw.txHash}:`,
      err
    );
    return null;
  }
}
