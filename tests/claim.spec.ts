import * as anchor from '@project-serum/anchor'
import { Program, Provider, BN } from '@project-serum/anchor'
import { Keypair, PublicKey } from '@solana/web3.js'
import { Network, SEED, Market, Pair } from '@invariant-labs/sdk'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { createToken, eqDecimal } from './testUtils'
import { assert } from 'chai'
import { DENOMINATOR } from '@invariant-labs/sdk'
import { TICK_LIMIT } from '@invariant-labs/sdk'
import { tou64 } from '@invariant-labs/sdk'
import { fromFee } from '@invariant-labs/sdk/lib/utils'
import { FeeTier, Decimal } from '@invariant-labs/sdk/lib/market'
import { toDecimal } from '@invariant-labs/sdk/src/utils'

describe('claim', () => {
  const provider = Provider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const positionOwner = Keypair.generate()
  const admin = Keypair.generate()
  let market: Market
  const feeTier: FeeTier = {
    fee: fromFee(new BN(600)), // 0.6%
    tickSpacing: 10
  }
  const protocolFee: Decimal = { v: fromFee(new BN(10000)) }
  let pair: Pair
  let tokenX: Token
  let tokenY: Token

  before(async () => {
    market = await Market.build(
      Network.LOCAL,
      provider.wallet,
      connection,
      anchor.workspace.Amm.programId
    )

    await Promise.all([
      connection.requestAirdrop(mintAuthority.publicKey, 1e9),
      connection.requestAirdrop(admin.publicKey, 1e9),
      connection.requestAirdrop(positionOwner.publicKey, 1e9)
    ])

    const tokens = await Promise.all([
      createToken(connection, wallet, mintAuthority),
      createToken(connection, wallet, mintAuthority)
    ])

    pair = new Pair(tokens[0].publicKey, tokens[1].publicKey, feeTier)
    tokenX = new Token(connection, pair.tokenX, TOKEN_PROGRAM_ID, wallet)
    tokenY = new Token(connection, pair.tokenY, TOKEN_PROGRAM_ID, wallet)

    await market.createState(admin, protocolFee)
  })
  it('#createState()', async () => {
    const state = await market.getState()
    const { bump } = await market.getStateAddress()
    const { programAuthority, nonce } = await market.getProgramAuthority()

    assert.ok(state.admin.equals(admin.publicKey))
    assert.ok(state.authority.equals(programAuthority))
    assert.ok(eqDecimal(state.protocolFee, protocolFee))
    assert.ok(state.nonce === nonce)
    assert.ok(state.bump === bump)
  })
  it('#createFeeTier()', async () => {
    await market.createFeeTier(feeTier, admin)
  })
  it('#create()', async () => {
    await market.create({
      pair,
      signer: positionOwner
    })
    const createdPool = await market.get(pair)
    assert.ok(createdPool.tokenX.equals(tokenX.publicKey))
    assert.ok(createdPool.tokenY.equals(tokenY.publicKey))
    assert.ok(createdPool.fee.v.eq(feeTier.fee))
    assert.equal(createdPool.tickSpacing, feeTier.tickSpacing)
    assert.ok(createdPool.liquidity.v.eqn(0))
    assert.ok(createdPool.sqrtPrice.v.eq(DENOMINATOR))
    assert.ok(createdPool.currentTickIndex == 0)
    assert.ok(createdPool.feeGrowthGlobalX.v.eqn(0))
    assert.ok(createdPool.feeGrowthGlobalY.v.eqn(0))
    assert.ok(createdPool.feeProtocolTokenX.v.eqn(0))
    assert.ok(createdPool.feeProtocolTokenY.v.eqn(0))

    const tickmapData = await market.getTickmap(pair)
    assert.ok(tickmapData.bitmap.length == TICK_LIMIT / 4)
    assert.ok(tickmapData.bitmap.every((v) => v == 0))
  })
  it('#claim', async () => {
    const upperTick = 10
    const lowerTick = -20

    await market.createTick(pair, upperTick, wallet)
    await market.createTick(pair, lowerTick, wallet)

    const userTokenXAccount = await tokenX.createAccount(positionOwner.publicKey)
    const userTokenYAccount = await tokenY.createAccount(positionOwner.publicKey)
    const mintAmount = tou64(new BN(10).pow(new BN(10)))

    await tokenX.mintTo(userTokenXAccount, mintAuthority.publicKey, [mintAuthority], mintAmount)
    await tokenY.mintTo(userTokenYAccount, mintAuthority.publicKey, [mintAuthority], mintAmount)

    const liquidityDelta = { v: new BN(1000000).mul(DENOMINATOR) }

    await market.createPositionList(positionOwner)
    await market.initPosition(
      {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick,
        upperTick,
        liquidityDelta
      },
      positionOwner
    )

    assert.ok((await market.get(pair)).liquidity.v.eq(liquidityDelta.v))

    const swapper = Keypair.generate()
    await connection.requestAirdrop(swapper.publicKey, 1e9)

    const amount = new BN(1000)
    const accountX = await tokenX.createAccount(swapper.publicKey)
    const accountY = await tokenY.createAccount(swapper.publicKey)

    await tokenX.mintTo(accountX, mintAuthority.publicKey, [mintAuthority], tou64(amount))

    const poolDataBefore = await market.get(pair)
    const priceLimit = DENOMINATOR.muln(100).divn(110)
    const reservesBeforeSwap = await market.getReserveBalances(pair, wallet)

    await market.swap(
      {
        pair,
        XtoY: true,
        amount,
        knownPrice: poolDataBefore.sqrtPrice,
        slippage: toDecimal(1, 2),
        accountX,
        accountY,
        byAmountIn: true
      },
      swapper
    )
    const poolDataAfter = await market.get(pair)
    assert.ok(poolDataAfter.liquidity.v.eq(poolDataBefore.liquidity.v))
    assert.ok(poolDataAfter.currentTickIndex == lowerTick)
    assert.ok(poolDataAfter.sqrtPrice.v.lt(poolDataBefore.sqrtPrice.v))

    const amountX = (await tokenX.getAccountInfo(accountX)).amount
    const amountY = (await tokenY.getAccountInfo(accountY)).amount
    const reservesAfterSwap = await market.getReserveBalances(pair, wallet)
    const reserveXDelta = reservesAfterSwap.x.sub(reservesBeforeSwap.x)
    const reserveYDelta = reservesBeforeSwap.y.sub(reservesAfterSwap.y)

    assert.ok(amountX.eqn(0))
    assert.ok(amountY.eq(amount.subn(7)))
    assert.ok(reserveXDelta.eq(amount))
    assert.ok(reserveYDelta.eq(amount.subn(7)))
    assert.ok(poolDataAfter.feeGrowthGlobalX.v.eqn(5400000))
    assert.ok(poolDataAfter.feeGrowthGlobalY.v.eqn(0))
    assert.ok(poolDataAfter.feeProtocolTokenX.v.eq(new BN(600000013280)))
    assert.ok(poolDataAfter.feeProtocolTokenY.v.eqn(0))

    const reservesBeforeClaim = await market.getReserveBalances(pair, wallet)
    const userTokenXAccountBeforeClaim = (await tokenX.getAccountInfo(userTokenXAccount)).amount

    await market.claimFee(
      {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        index: 0
      },
      positionOwner
    )

    const userTokenXAccountAfterClaim = (await tokenX.getAccountInfo(userTokenXAccount)).amount
    const positionAfterClaim = await market.getPosition(positionOwner.publicKey, 0)
    const reservesAfterClaim = await market.getReserveBalances(pair, wallet)
    const expectedTokensOwedX = new BN(400000000000)
    const expectedFeeGrowthInsideX = new BN(5400000)
    const expectedTokensClaimed = 5

    assert.ok(reservesBeforeClaim.x.subn(5).eq(reservesAfterClaim.x))
    assert.ok(expectedTokensOwedX.eq(positionAfterClaim.tokensOwedX.v))
    assert.ok(expectedFeeGrowthInsideX.eq(positionAfterClaim.feeGrowthInsideX.v))
    assert.ok(
      userTokenXAccountAfterClaim.sub(userTokenXAccountBeforeClaim).eqn(expectedTokensClaimed)
    )
  })
})
