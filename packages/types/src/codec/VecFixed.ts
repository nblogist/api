// Copyright 2017-2021 @polkadot/types authors & contributors
// SPDX-License-Identifier: Apache-2.0

import type { Codec, Constructor, Registry } from '../types';

import { assert, compactToU8a, isHex, isU8a, u8aConcat } from '@polkadot/util';

import { AbstractArray } from './AbstractArray';
import { typeToConstructor } from './utils';
import { Vec } from './Vec';

/** @internal */
function decodeVecFixed<T extends Codec> (registry: Registry, Type: Constructor<T>, allocLength: number, value: VecFixed<any> | Uint8Array | string | any[]): T[] {
  const values = Vec.decodeVec(
    registry,
    Type,
    isU8a(value) || isHex(value)
      ? u8aConcat(compactToU8a(allocLength), value)
      : value
  );

  while (values.length < allocLength) {
    values.push(new Type(registry));
  }

  assert(values.length === allocLength, () => `Expected a length of exactly ${allocLength} entries`);

  return values;
}

/**
 * @name VecFixed
 * @description
 * This manages codec arrays of a fixed length
 */
export class VecFixed<T extends Codec> extends AbstractArray<T> {
  private _Type: Constructor<T>;

  constructor (registry: Registry, Type: Constructor<T> | string, length: number, value: VecFixed<any> | Uint8Array | string | any[] = [] as any[]) {
    const Clazz = typeToConstructor<T>(registry, Type);

    super(registry, decodeVecFixed(registry, Clazz, length, value));

    this._Type = Clazz;
  }

  public static with<O extends Codec> (Type: Constructor<O> | string, length: number): Constructor<VecFixed<O>> {
    return class extends VecFixed<O> {
      constructor (registry: Registry, value?: any[]) {
        super(registry, Type, length, value);
      }
    };
  }

  /**
   * @description The type for the items
   */
  public get Type (): string {
    return new this._Type(this.registry).toRawType();
  }

  /**
   * @description The length of the value when encoded as a Uint8Array
   */
  public override get encodedLength (): number {
    return this.reduce((total, entry) => total + entry.encodedLength, 0);
  }

  public override toU8a (): Uint8Array {
    // we override, we don't add the length prefix for ourselves, and at the same time we
    // ignore isBare on entries, since they should be properly encoded at all times
    const encoded = this.map((entry) => entry.toU8a());

    return encoded.length
      ? u8aConcat(...encoded)
      : new Uint8Array([]);
  }

  /**
   * @description Returns the base runtime type name for this instance
   */
  public toRawType (): string {
    return `[${this.Type};${this.length}]`;
  }
}
