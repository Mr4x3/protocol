import * as anchor from '@project-serum/anchor'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { assert } from 'chai'
import {
  Market,
  Pair,
  SEED,
  tou64,
  TICK_LIMIT,
  signAndSend,
  calculate_price_sqrt,
  fromInteger,
  Network
} from '@invariant-labs/sdk'
import { Provider, Program, BN } from '@project-serum/anchor'
import { Token, u64, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { createToken, eqDecimal } from './testUtils'
import { assertThrowsAsync } from '@invariant-labs/sdk/src/utils'
import { ERRORS } from '@invariant-labs/sdk/lib/utils'

describe('Position list', () => {
  const provider = Provider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const positionOwner = Keypair.generate()
  const admin = Keypair.generate()
  const market = new Market(
    Network.LOCAL,
    provider.wallet,
    connection,
    anchor.workspace.Amm.programId
  )
  let pair: Pair
  let tokenX: Token
  let tokenY: Token
  let programAuthority: PublicKey
  let nonce: number
  let initTick: number
  let ticksIndexes: Array<number>
  let xOwnerAmount: u64
  let yOwnerAmount: u64
  let userTokenXAccount: PublicKey
  let userTokenYAccount: PublicKey

  before(async () => {
    const swaplineProgram = anchor.workspace.Amm as Program
    const [_programAuthority, _nonce] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from(SEED)],
      swaplineProgram.programId
    )
    nonce = _nonce
    programAuthority = _programAuthority
    // Request airdrops
    await Promise.all([
      await connection.requestAirdrop(wallet.publicKey, 1e9),
      await connection.requestAirdrop(mintAuthority.publicKey, 1e9),
      await connection.requestAirdrop(admin.publicKey, 1e9),
      await connection.requestAirdrop(positionOwner.publicKey, 1e9)
    ])
    // Create pair
    const tokens = await Promise.all([
      createToken(connection, wallet, mintAuthority),
      createToken(connection, wallet, mintAuthority)
    ])
    pair = new Pair(tokens[0].publicKey, tokens[1].publicKey)
    tokenX = new Token(connection, pair.tokenX, TOKEN_PROGRAM_ID, wallet)
    tokenY = new Token(connection, pair.tokenY, TOKEN_PROGRAM_ID, wallet)

    // user deposit
    userTokenXAccount = await tokenX.createAccount(positionOwner.publicKey)
    userTokenYAccount = await tokenY.createAccount(positionOwner.publicKey)

    await tokenX.mintTo(userTokenXAccount, mintAuthority.publicKey, [mintAuthority], xOwnerAmount)
    await tokenY.mintTo(userTokenYAccount, mintAuthority.publicKey, [mintAuthority], yOwnerAmount)
  })
  it('Prepare pool', async () => {
    const fee = 600
    const tickSpacing = 3
    initTick = -23028

    await market.create({
      pair,
      signer: admin,
      initTick,
      fee,
      tickSpacing
    })
    await market.createPositionList(positionOwner)

    ticksIndexes = [-9780, -42, 0, 9, 276, 32343]
    Promise.all(
      ticksIndexes.map(async (tickIndex) => {
        const ix = await market.createTickInstruction(pair, tickIndex, wallet.publicKey)
        await signAndSend(new Transaction().add(ix), [wallet], connection)
      })
    )
  })
  it('Remove from empty list should failed', async () => {
    const ix = await market.removePositionInstruction(positionOwner.publicKey, 0)
    assertThrowsAsync(signAndSend(new Transaction().add(ix), [positionOwner], connection))
  })
  it('Add multiple position', async () => {
    xOwnerAmount = tou64(1e10)
    yOwnerAmount = tou64(1e10)

    await tokenX.mintTo(userTokenXAccount, mintAuthority.publicKey, [mintAuthority], xOwnerAmount)
    await tokenY.mintTo(userTokenYAccount, mintAuthority.publicKey, [mintAuthority], yOwnerAmount)

    await market.initPosition(
      {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[0],
        upperTick: ticksIndexes[1],
        liquidityDelta: fromInteger(1)
      },
      positionOwner
    )
    // create position with the same tick should pass
    await market.initPosition(
      {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[0],
        upperTick: ticksIndexes[1],
        liquidityDelta: fromInteger(1)
      },
      positionOwner
    )
    await market.initPosition(
      {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[0],
        upperTick: ticksIndexes[2],
        liquidityDelta: fromInteger(1)
      },
      positionOwner
    )
    await market.initPosition(
      {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[1],
        upperTick: ticksIndexes[4],
        liquidityDelta: fromInteger(1)
      },
      positionOwner
    )
  })
  it('Remove middle position', async () => {
    const positionIndexToRemove = 2
    const positionListBefore = await market.getPositionList(positionOwner.publicKey)
    const positionsBefore = await market.getPositionsFromRange(
      positionOwner.publicKey,
      0,
      positionListBefore.head - 1
    )
    const lastPosition = positionsBefore[positionListBefore.head - 1]

    const ix = await market.removePositionInstruction(
      positionOwner.publicKey,
      positionIndexToRemove
    )
    await signAndSend(new Transaction().add(ix), [positionOwner], connection)

    const positionListAfter = await market.getPositionList(positionOwner.publicKey)
    const positionsAfter = await market.getPositionsFromRange(
      positionOwner.publicKey,
      0,
      positionListAfter.head - 1
    )

    // check position list head
    assert.ok(positionListBefore.head - 1 == positionListAfter.head)

    // last position should be at removed index
    const testedPosition = positionsAfter[positionIndexToRemove]
    assert.ok(lastPosition.pool.equals(testedPosition.pool))
    assert.ok(eqDecimal(lastPosition.liquidity, testedPosition.liquidity))
    assert.ok(lastPosition.lowerTickIndex === testedPosition.lowerTickIndex)
    assert.ok(lastPosition.upperTickIndex === testedPosition.upperTickIndex)
    assert.ok(eqDecimal(lastPosition.feeGrowthInsideX, testedPosition.feeGrowthInsideX))
    assert.ok(eqDecimal(lastPosition.feeGrowthInsideY, testedPosition.feeGrowthInsideY))
    assert.ok(eqDecimal(lastPosition.tokensOwedX, testedPosition.tokensOwedX))
    assert.ok(eqDecimal(lastPosition.tokensOwedY, testedPosition.tokensOwedY))
  })
  it('Add position in place of the removed one', async () => {
    const positionListBefore = await market.getPositionList(positionOwner.publicKey)
    await market.initPosition(
      {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[1],
        upperTick: ticksIndexes[2],
        liquidityDelta: fromInteger(1)
      },
      positionOwner
    )
    const positionListAfter = await market.getPositionList(positionOwner.publicKey)

    assert.equal(positionListBefore.head + 1, positionListAfter.head)
  })
  it('Remove last position', async () => {
    const lastPositionIndexBefore = (await market.getPositionList(positionOwner.publicKey)).head - 1
    const ix = await market.removePositionInstruction(
      positionOwner.publicKey,
      lastPositionIndexBefore
    )
    await signAndSend(new Transaction().add(ix), [positionOwner], connection)

    const lastPositionIndexAfter = (await market.getPositionList(positionOwner.publicKey)).head - 1
    assert.equal(lastPositionIndexBefore - 1, lastPositionIndexAfter)
  })
  it('Only owner can modify position list', async () => {
    const positionListBefore = await market.getPositionList(positionOwner.publicKey)
    const initPositionTx = await market.initPositionTx({
      pair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick: ticksIndexes[0],
      upperTick: ticksIndexes[3],
      liquidityDelta: fromInteger(1)
    })
    const removePositionIx = await market.removePositionInstruction(positionOwner.publicKey, 0)

    assertThrowsAsync(signAndSend(initPositionTx, [wallet], connection), ERRORS.SIGNATURE)
    assertThrowsAsync(
      signAndSend(new Transaction().add(removePositionIx), [wallet], connection),
      ERRORS.SIGNATURE
    )

    const positionListAfter = await market.getPositionList(positionOwner.publicKey)
    assert.equal(positionListBefore.head, positionListAfter.head)
  })
  it('Remove all positions', async () => {
    const positionListBefore = await market.getPositionList(positionOwner.publicKey)

    for (let i = positionListBefore.head - 1; i >= 0; i--) {
      const ix = await market.removePositionInstruction(positionOwner.publicKey, i)
      await signAndSend(new Transaction().add(ix), [positionOwner], connection)
    }
    const positionListAfter = await market.getPositionList(positionOwner.publicKey)
    assert.equal(positionListAfter.head, 0)
  })
  it('Add position to cleared list', async () => {
    const positionListBefore = await market.getPositionList(positionOwner.publicKey)
    await market.initPosition(
      {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[0],
        upperTick: ticksIndexes[1],
        liquidityDelta: fromInteger(1)
      },
      positionOwner
    )
    const positionListAfter = await market.getPositionList(positionOwner.publicKey)
    assert.equal(positionListBefore.head + 1, positionListAfter.head)
  })
})