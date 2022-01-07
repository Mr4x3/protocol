import * as anchor from '@project-serum/anchor'
import { Program, Provider, BN } from '@project-serum/anchor'
import { Market, Pair } from '@invariant-labs/sdk'
import { Staker as StakerIdl } from '../sdk-staker/src/idl/staker'
import { Staker } from '../sdk-staker/lib/staker'
import { Keypair, PublicKey } from '@solana/web3.js'
import { assert } from 'chai'
import { Decimal } from '../sdk-staker/src/staker'
import { STAKER_SEED } from '../sdk-staker/src/utils'
import {
  eqDecimal,
  createToken,
  tou64,
  createIncentive,
  assertThrowsAsync,
  ERRORS_STAKER
} from './utils'
import {
  createFeeTier,
  createPool,
  createState,
  createToken as createTkn
} from '../tests/testUtils'
import { fromFee } from '@invariant-labs/sdk/lib/utils'
import { FeeTier } from '@invariant-labs/sdk/lib/market'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CreateFeeTier, CreatePool } from '@invariant-labs/sdk/src/market'
import { CreateIncentive } from '../sdk-staker/lib/staker'
import { Network } from '../sdk-staker/lib'

describe('Create incentive tests', () => {
  const provider = Provider.local()
  const connection = provider.connection
  const program = anchor.workspace.Staker as Program<StakerIdl>
  // @ts-expect-error
  const wallet = provider.wallet.payer as Account
  const protocolFee: Decimal = { v: fromFee(new BN(10000)) }
  let stakerAuthority: PublicKey
  const mintAuthority = Keypair.generate()
  const founderAccount = Keypair.generate()
  const admin = Keypair.generate()
  let staker: Staker
  let pool: PublicKey
  let amm: PublicKey
  let incentiveToken: Token

  let tokenX: Token
  let tokenY: Token
  let founderTokenAcc: PublicKey
  let incentiveTokenAcc: PublicKey
  let amount: BN
  let pair: Pair

  before(async () => {
    //create staker instance
    const [_mintAuthority, _nonce] = await anchor.web3.PublicKey.findProgramAddress(
      [STAKER_SEED],
      program.programId
    )
    stakerAuthority = _mintAuthority
    staker = new Staker(connection, Network.LOCAL, provider.wallet, program.programId)

    //create token
    incentiveToken = await createToken({
      connection: connection,
      payer: wallet,
      mintAuthority: wallet.publicKey
    })
    //add SOL to founder acc
    await connection.requestAirdrop(founderAccount.publicKey, 10e9)

    //create taken acc for founder and staker
    founderTokenAcc = await incentiveToken.createAccount(founderAccount.publicKey)
    incentiveTokenAcc = await incentiveToken.createAccount(stakerAuthority)

    //mint to founder acc
    amount = new anchor.BN(100 * 1e6)
    await incentiveToken.mintTo(founderTokenAcc, wallet, [], tou64(amount))

    //create amm and pool

    const market = await Market.build(
      0,
      provider.wallet,
      connection,
      anchor.workspace.Amm.programId
    )

    const tokens = await Promise.all([
      createTkn(connection, wallet, mintAuthority),
      createTkn(connection, wallet, mintAuthority),
      await connection.requestAirdrop(admin.publicKey, 1e9)
    ])

    // create pool
    const feeTier: FeeTier = {
      fee: fromFee(new BN(600)),
      tickSpacing: 10
    }

    pair = new Pair(tokens[0].publicKey, tokens[1].publicKey, feeTier)

    tokenX = new Token(connection, pair.tokenX, TOKEN_PROGRAM_ID, wallet)
    tokenY = new Token(connection, pair.tokenY, TOKEN_PROGRAM_ID, wallet)

    await createState(market, admin.publicKey, admin)

    const createFeeTierVars: CreateFeeTier = {
      feeTier,
      admin: admin.publicKey
    }
    await createFeeTier(market, createFeeTierVars, admin)

    const createPoolVars: CreatePool = {
      pair,
      payer: admin,
      protocolFee,
      tokenX,
      tokenY
    }
    await createPool(market, createPoolVars)
    pool = await pair.getAddress(anchor.workspace.Amm.programId)
    amm = anchor.workspace.Amm.programId
  })

  it('Create incentive ', async () => {
    const incentiveAccount = Keypair.generate()
    await connection.requestAirdrop(incentiveAccount.publicKey, 10e9)
    await new Promise(resolve => {
      setTimeout(() => {
        resolve(null)
      }, 1000)
    })
    const seconds = new Date().valueOf() / 1000
    const currentTime = new BN(Math.floor(seconds))
    const reward: Decimal = { v: new BN(10) }
    const startTime = currentTime.add(new BN(0))
    const endTime = currentTime.add(new BN(31_000_000))
    const totalSecondsClaimed: Decimal = { v: new BN(0) }

    const createIncentiveVars: CreateIncentive = {
      reward,
      startTime,
      endTime,
      incentive: incentiveAccount.publicKey,
      pool,
      founder: founderAccount.publicKey,
      incentiveTokenAcc: incentiveTokenAcc,
      founderTokenAcc: founderTokenAcc,
      amm: amm
    }
    await createIncentive(staker, createIncentiveVars, [founderAccount, incentiveAccount])

    const createdIncentive = await staker.getIncentive(incentiveAccount.publicKey)
    assert.ok(eqDecimal(createdIncentive.totalRewardUnclaimed, reward))
    assert.ok(eqDecimal(createdIncentive.totalSecondsClaimed, totalSecondsClaimed))
    assert.ok(createdIncentive.startTime.eq(startTime))
    assert.ok(createdIncentive.endTime.eq(endTime))
    assert.ok(createdIncentive.pool.equals(pool))
  })

  it('Fail on zero amount', async () => {
    const incentiveAccount = Keypair.generate()
    await connection.requestAirdrop(incentiveAccount.publicKey, 10e9)
    await new Promise(resolve => {
      setTimeout(() => {
        resolve(null)
      }, 1000)
    })

    const seconds = new Date().valueOf() / 1000
    const currentTime = new BN(Math.floor(seconds))
    const reward: Decimal = { v: new BN(0) }
    const startTime = currentTime.add(new BN(0))
    const endTime = currentTime.add(new BN(31_000_000))

    const createIncentiveVars: CreateIncentive = {
      reward,
      startTime,
      endTime,
      incentive: incentiveAccount.publicKey,
      pool,
      founder: founderAccount.publicKey,
      incentiveTokenAcc: incentiveTokenAcc,
      founderTokenAcc: founderTokenAcc,
      amm: amm
    }

    await assertThrowsAsync(
      createIncentive(staker, createIncentiveVars, [founderAccount, incentiveAccount]),
      ERRORS_STAKER.ZERO_AMOUNT
    )
  })

  it('Fail, incentive starts more than one hour in past ', async () => {
    const incentiveAccount = Keypair.generate()
    await connection.requestAirdrop(incentiveAccount.publicKey, 10e9)
    await new Promise(resolve => {
      setTimeout(() => {
        resolve(null)
      }, 1000)
    })

    const seconds = new Date().valueOf() / 1000
    const currentTime = new BN(Math.floor(seconds))
    const reward: Decimal = { v: new BN(1000) }
    const startTime = currentTime.add(new BN(-4000))
    const endTime = currentTime.add(new BN(31_000_000))

    const createIncentiveVars: CreateIncentive = {
      reward,
      startTime,
      endTime,
      incentive: incentiveAccount.publicKey,
      pool,
      founder: founderAccount.publicKey,
      incentiveTokenAcc: incentiveTokenAcc,
      founderTokenAcc: founderTokenAcc,
      amm: amm
    }

    await assertThrowsAsync(
      createIncentive(staker, createIncentiveVars, [founderAccount, incentiveAccount]),
      ERRORS_STAKER.START_IN_PAST
    )
  })

  it('Fail, too long incentive time', async () => {
    const incentiveAccount = Keypair.generate()
    await connection.requestAirdrop(incentiveAccount.publicKey, 10e9)
    await new Promise(resolve => {
      setTimeout(() => {
        resolve(null)
      }, 1000)
    })

    const seconds = new Date().valueOf() / 1000
    const currentTime = new BN(Math.floor(seconds))
    const reward: Decimal = { v: new BN(1000) }
    const startTime = currentTime.add(new BN(0))
    const endTime = currentTime.add(new BN(32_000_000))

    const createIncentiveVars: CreateIncentive = {
      reward,
      startTime,
      endTime,
      incentive: incentiveAccount.publicKey,
      pool,
      founder: founderAccount.publicKey,
      incentiveTokenAcc: incentiveTokenAcc,
      founderTokenAcc: founderTokenAcc,
      amm: amm
    }

    await assertThrowsAsync(
      createIncentive(staker, createIncentiveVars, [founderAccount, incentiveAccount]),
      ERRORS_STAKER.TO_LONG_DURATION
    )
  })
  it('Check if amount on incentive token account after donate is correct', async () => {
    const incentiveAccount = Keypair.generate()
    await connection.requestAirdrop(incentiveAccount.publicKey, 10e9)
    const balanceBefore = (await incentiveToken.getAccountInfo(incentiveTokenAcc)).amount
    await new Promise(resolve => {
      setTimeout(() => {
        resolve(null)
      }, 1000)
    })

    const seconds = new Date().valueOf() / 1000
    const currentTime = new BN(Math.floor(seconds))
    const reward: Decimal = { v: new BN(1000) }
    const startTime = currentTime.add(new BN(0))
    const endTime = currentTime.add(new BN(31_000_000))

    const createIncentiveVars: CreateIncentive = {
      reward,
      startTime,
      endTime,
      incentive: incentiveAccount.publicKey,
      pool,
      founder: founderAccount.publicKey,
      incentiveTokenAcc: incentiveTokenAcc,
      founderTokenAcc: founderTokenAcc,
      amm: amm
    }

    await createIncentive(staker, createIncentiveVars, [founderAccount, incentiveAccount])
    const balance = (await incentiveToken.getAccountInfo(incentiveTokenAcc)).amount
    assert.ok(balance.eq(new BN(reward.v).add(balanceBefore)))
  })
})
