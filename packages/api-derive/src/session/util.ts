// Copyright 2017-2021 @polkadot/api-derive authors & contributors
// SPDX-License-Identifier: Apache-2.0

import type { Option } from '@polkadot/types';
import type { ActiveEraInfo } from '@polkadot/types/interfaces';

import { isFunction } from '@polkadot/util';

export function isActiveOpt (value: ActiveEraInfo | Option<ActiveEraInfo>): value is Option<ActiveEraInfo> {
  return isFunction((value as Option<ActiveEraInfo>).unwrapOrDefault);
}
