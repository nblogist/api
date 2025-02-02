// Copyright 2017-2021 @polkadot/api-derive authors & contributors
// SPDX-License-Identifier: Apache-2.0

import type { Observable } from 'rxjs';
import type { ApiInterfaceRx, QueryableStorageMultiArg } from '@polkadot/api/types';
import type { Option, Vec } from '@polkadot/types';
import type { AccountId, AccountIndex, Address, Balance, BalanceLock, BalanceLockTo212, BlockNumber, VestingInfo, VestingSchedule } from '@polkadot/types/interfaces';
import type { DeriveBalancesAccount, DeriveBalancesAccountData, DeriveBalancesAll, DeriveBalancesAllAccountData } from '../types';

import { combineLatest, map, of, switchMap } from 'rxjs';

import { BN, bnMax, isFunction } from '@polkadot/util';

import { memo } from '../util';

type BalanceLocksEntry = Vec<BalanceLock | BalanceLockTo212>;
type BalanceLocks = BalanceLocksEntry[];
type ResultBalance = [VestingInfo | null, ((BalanceLock | BalanceLockTo212)[])[]];
type Result = [DeriveBalancesAccount, BlockNumber, ResultBalance];

interface AllLocked {
  allLocked: boolean,
  lockedBalance: Balance,
  lockedBreakdown: (BalanceLock | BalanceLockTo212)[],
  vestingLocked: Balance
}

type DeriveCustomLocks = ApiInterfaceRx['derive'] & {
  [custom: string]: {
    customLocks?: ApiInterfaceRx['query']['balances']['locks']
  }
}

const VESTING_ID = '0x76657374696e6720';

function calcLocked (api: ApiInterfaceRx, bestNumber: BlockNumber, locks: (BalanceLock | BalanceLockTo212)[]): AllLocked {
  let lockedBalance = api.registry.createType('Balance');
  let lockedBreakdown: (BalanceLock | BalanceLockTo212)[] = [];
  let vestingLocked = api.registry.createType('Balance');
  let allLocked = false;

  if (Array.isArray(locks)) {
    // only get the locks that are valid until passed the current block
    lockedBreakdown = (locks as BalanceLockTo212[]).filter(({ until }): boolean => !until || (bestNumber && until.gt(bestNumber)));
    allLocked = lockedBreakdown.some(({ amount }) => amount && amount.isMax());
    vestingLocked = api.registry.createType('Balance', lockedBreakdown.filter(({ id }) => id.eq(VESTING_ID)).reduce((result: BN, { amount }) => result.iadd(amount), new BN(0)));

    // get the maximum of the locks according to https://github.com/paritytech/substrate/blob/master/srml/balances/src/lib.rs#L699
    const notAll = lockedBreakdown.filter(({ amount }) => amount && !amount.isMax());

    if (notAll.length) {
      lockedBalance = api.registry.createType('Balance', bnMax(...notAll.map(({ amount }): Balance => amount)));
    }
  }

  return { allLocked, lockedBalance, lockedBreakdown, vestingLocked };
}

function calcShared (api: ApiInterfaceRx, bestNumber: BlockNumber, data: DeriveBalancesAccountData, locks: (BalanceLock | BalanceLockTo212)[]): DeriveBalancesAllAccountData {
  const { allLocked, lockedBalance, lockedBreakdown, vestingLocked } = calcLocked(api, bestNumber, locks);

  return {
    ...data,
    availableBalance: api.registry.createType('Balance', allLocked ? 0 : bnMax(new BN(0), data.freeBalance.sub(lockedBalance))),
    lockedBalance,
    lockedBreakdown,
    vestingLocked
  };
}

function calcBalances (api: ApiInterfaceRx, [data, bestNumber, [vesting, allLocks]]: Result): DeriveBalancesAll {
  const shared = calcShared(api, bestNumber, data, allLocks[0]);
  // Calculate the vesting balances,
  //  - offset = balance locked at startingBlock
  //  - perBlock is the unlock amount
  const emptyVest = api.registry.createType('VestingInfo');
  const { locked: vestingTotal, perBlock, startingBlock } = vesting || emptyVest;
  const isStarted = bestNumber.gt(startingBlock);
  const vestedNow = isStarted ? perBlock.mul(bestNumber.sub(startingBlock)) : new BN(0);
  const vestedBalance = vestedNow.gt(vestingTotal) ? vestingTotal : api.registry.createType('Balance', vestedNow);
  const isVesting = isStarted && !shared.vestingLocked.isZero();

  return {
    ...shared,
    accountId: data.accountId,
    accountNonce: data.accountNonce,
    additional: allLocks.filter((_, index) => index !== 0).map((l, index) => calcShared(api, bestNumber, data.additional[index], l)),
    isVesting,
    vestedBalance,
    vestedClaimable: api.registry.createType('Balance', isVesting ? shared.vestingLocked.sub(vestingTotal.sub(vestedBalance)) : 0),
    vestingEndBlock: api.registry.createType('BlockNumber', isVesting ? vestingTotal.div(perBlock).add(startingBlock) : 0),
    vestingPerBlock: perBlock,
    vestingTotal
  };
}

// old
function queryOld (api: ApiInterfaceRx, accountId: AccountId): Observable<ResultBalance> {
  return api.queryMulti<[Vec<BalanceLock>, Option<VestingSchedule>]>([
    [api.query.balances.locks, accountId],
    [api.query.balances.vesting, accountId]
  ]).pipe(
    map(([locks, optVesting]): ResultBalance => {
      let vestingNew = null;

      if (optVesting.isSome) {
        const { offset: locked, perBlock, startingBlock } = optVesting.unwrap();

        vestingNew = api.registry.createType('VestingInfo', { locked, perBlock, startingBlock });
      }

      return [vestingNew, [locks]];
    })
  );
}

const isNonNullable = <T>(nullable: T): nullable is NonNullable<T> => !!nullable;

// current (balances, vesting)
function queryCurrent (api: ApiInterfaceRx, accountId: AccountId, balanceInstances: string[] = ['balances']): Observable<ResultBalance> {
  const calls = balanceInstances.map((m): ApiInterfaceRx['query']['balances']['locks'] | undefined =>
    (api.derive as DeriveCustomLocks)[m]?.customLocks || api.query[m as 'balances']?.locks
  );
  const lockEmpty = calls.map((c) => !c);
  const queries = calls.filter(isNonNullable).map((c): QueryableStorageMultiArg<'rxjs'> => [c, accountId]);

  return (
    api.query.vesting?.vesting
      ? api.queryMulti<[Option<VestingInfo>, ...BalanceLocks]>([[api.query.vesting.vesting, accountId], ...queries])
      // TODO We need to check module instances here as well, not only the balances module
      : queries.length
        ? api.queryMulti<[...(Vec<BalanceLock>)[]]>(queries).pipe(
          map((r): [Option<VestingInfo>, ...BalanceLocks] => [api.registry.createType('Option<VestingInfo>'), ...r])
        )
        : of([api.registry.createType('Option<VestingInfo>')] as [Option<VestingInfo>])
  ).pipe(
    map(([opt, ...locks]): ResultBalance => {
      let offset = -1;

      return [
        opt.unwrapOr(null),
        lockEmpty.map((e) => e ? api.registry.createType('Vec<BalanceLock>') : locks[++offset])
      ];
    })
  );
}

/**
 * @name all
 * @param {( AccountIndex | AccountId | Address | string )} address - An accounts Id in different formats.
 * @returns An object containing the results of various balance queries
 * @example
 * <BR>
 *
 * ```javascript
 * const ALICE = 'F7Hs';
 *
 * api.derive.balances.all(ALICE, ({ accountId, lockedBalance }) => {
 *   console.log(`The account ${accountId} has a locked balance ${lockedBalance} units.`);
 * });
 * ```
 */
export function all (instanceId: string, api: ApiInterfaceRx): (address: AccountIndex | AccountId | Address | string) => Observable<DeriveBalancesAll> {
  const balanceInstances = api.registry.getModuleInstances(api.runtimeVersion.specName.toString(), 'balances');

  return memo(instanceId, (address: AccountIndex | AccountId | Address | string): Observable<DeriveBalancesAll> =>
    api.derive.balances.account(address).pipe(
      switchMap((account): Observable<Result> =>
        (!account.accountId.isEmpty
          ? combineLatest([
            of(account),
            api.derive.chain.bestNumber(),
            isFunction(api.query.system?.account) || isFunction(api.query.balances?.account)
              ? queryCurrent(api, account.accountId, balanceInstances)
              : queryOld(api, account.accountId)
          ])
          : of([account, api.registry.createType('BlockNumber'), [null, []]])
        )
      ),
      map((result): DeriveBalancesAll => calcBalances(api, result))
    ));
}
