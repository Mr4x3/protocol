import * as anchor from '@project-serum/anchor'
import { BN, Program, utils, Idl, Provider } from '@project-serum/anchor'
import { Token, TOKEN_PROGRAM_ID, u64 } from '@solana/spl-token'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  Signer
} from '@solana/web3.js'
import { calculatePriceAfterSlippage, findClosestTicks, isInitialized } from './math'
import {
  feeToTickSpacing,
  generateTicksArray,
  getFeeTierAddress,
  parseLiquidityOnTicks,
  SEED,
  signAndSend
} from './utils'
import { Amm, IDL } from './idl/amm'
import { IWallet, Pair } from '.'
import { getMarketAddress } from './network'

import { Network } from './network'
const POSITION_SEED = 'positionv1'
const TICK_SEED = 'tickv1'
const POSITION_LIST_SEED = 'positionlistv1'
const STATE_SEED = 'statev1'
export const FEE_TIER = 'feetierv1'
export const DEFAULT_PUBLIC_KEY = new PublicKey(0)

export class Market {
  public connection: Connection
  public wallet: IWallet
  public program: Program<Amm>
  public stateAddress: PublicKey = PublicKey.default
  public programAuthority: PublicKey = PublicKey.default

  private constructor(
    network: Network,
    wallet: IWallet,
    connection: Connection,
    programId?: PublicKey
  ) {
    this.connection = connection
    this.wallet = wallet
    const programAddress = new PublicKey(getMarketAddress(network))
    const provider = new Provider(connection, wallet, Provider.defaultOptions())

    this.program = new Program(IDL, programAddress, provider)
  }

  public static async build(
    network: Network,
    wallet: IWallet,
    connection: Connection,
    programId?: PublicKey
  ): Promise<Market> {
    const instance = new Market(network, wallet, connection, programId)
    instance.stateAddress = (await instance.getStateAddress()).address
    instance.programAuthority = (await instance.getProgramAuthority()).programAuthority

    return instance
  }

  async create({ pair, signer, initTick, protocolFee }: CreatePool) {
    const tick = initTick || 0

    const { address: stateAddress } = await this.getStateAddress()
    console.log("stateAddress: ", stateAddress.toString())

    const [poolAddress, bump] = await pair.getAddressAndBump(this.program.programId)
    const { address: feeTierAddress } = await this.getFeeTierAddress(pair.feeTier)

    const tokenX = new Token(this.connection, pair.tokenX, TOKEN_PROGRAM_ID, signer)
    const tokenY = new Token(this.connection, pair.tokenY, TOKEN_PROGRAM_ID, signer)

    const tokenXReserve = await tokenX.createAccount(this.programAuthority)
    const tokenYReserve = await tokenY.createAccount(this.programAuthority)

    const bitmapKeypair = Keypair.generate()
    
    console.log("############################")
    await this.program.rpc.createPool(bump, tick, protocolFee, {
      accounts: {
        state: stateAddress,
        pool: poolAddress,
        feeTier: feeTierAddress,
        tickmap: bitmapKeypair.publicKey,
        tokenX: tokenX.publicKey,
        tokenY: tokenY.publicKey,
        tokenXReserve,
        tokenYReserve,
        payer: signer.publicKey,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      },
      signers: [signer, bitmapKeypair],
      instructions: [await this.program.account.tickmap.createInstruction(bitmapKeypair)]
    })
    console.log("############################")
    
  }

  async getProgramAuthority() {
    const [programAuthority, nonce] = await PublicKey.findProgramAddress(
      [Buffer.from(SEED)],
      this.program.programId
    )

    return {
      programAuthority,
      nonce
    }
  }

  async getFeeTier(feeTier: FeeTier) {
    const { address } = await this.getFeeTierAddress(feeTier)
    return (await this.program.account.feeTier.fetch(address)) as FeeTierStructure
  }

  async changeProtocolFee(pair: Pair, protocol_fee: Decimal) {
    const stateAddress = this.getStateAddress()
    const poolAddress = pair.getAddress(this.program.programId)
    const feeTierAddress = pair.getFeeTierAddress(this.program.programId)
    
  }

  async getPool(pair: Pair) {
    const address = await pair.getAddress(this.program.programId)
    return (await this.program.account.pool.fetch(address)) as PoolStructure
  }

  public async onPoolChange(
    tokenX: PublicKey,
    tokenY: PublicKey,
    feeTier: FeeTier,
    fn: (poolStructure: PoolStructure) => void
  ) {
    const poolAddress = await new Pair(tokenX, tokenY, feeTier).getAddress(this.program.programId)

    this.program.account.pool
      .subscribe(poolAddress, 'singleGossip') // REVIEW use recent commitment + allow overwrite via props
      .on('change', (poolStructure: PoolStructure) => {
        fn(poolStructure)
      })
  }

  async getFeeTierAddress(feeTier: FeeTier) {
    return await getFeeTierAddress(feeTier, this.program.programId)
  }

  async getTickmap(pair: Pair) {
    const state = await this.getPool(pair)
    const tickmap = (await this.program.account.tickmap.fetch(state.tickmap)) as Tickmap
    return tickmap
  }

  async isInitialized(pair: Pair, index: number) {
    const state = await this.getPool(pair)
    const tickmap = await this.getTickmap(pair)
    return isInitialized(tickmap, index, state.tickSpacing)
  }

  async getTick(pair: Pair, index: number) {
    const { tickAddress } = await this.getTickAddress(pair, index)
    return (await this.program.account.tick.fetch(tickAddress)) as Tick
  }

  async getClosestTicks(pair: Pair, limit: number, maxRange?: number) {
    const state = await this.getPool(pair)
    const tickmap = await this.getTickmap(pair)
    const indexes = findClosestTicks(
      tickmap.bitmap,
      state.currentTickIndex,
      state.tickSpacing,
      limit,
      maxRange
    )

    return Promise.all(
      indexes.map(async (index) => {
        const { tickAddress } = await this.getTickAddress(pair, index)
        return (await this.program.account.tick.fetch(tickAddress)) as Tick
      })
    )
  }

  async getLiquidityOnTicks(pair: Pair) {
    const pool = await this.getPool(pair)
    const ticks = await this.getClosestTicks(pair, Infinity)

    return parseLiquidityOnTicks(ticks, pool)
  }

  async getPositionList(owner: PublicKey) {
    const { positionListAddress } = await this.getPositionListAddress(owner)
    return (await this.program.account.positionList.fetch(positionListAddress)) as PositionList
  }

  async getPosition(owner: PublicKey, index: number) {
    const { positionAddress } = await this.getPositionAddress(owner, index)
    return (await this.program.account.position.fetch(positionAddress)) as Position
  }

  async getPositionsFromIndexes(owner: PublicKey, indexes: Array<number>) {
    const positionPromises = indexes.map(async (i) => {
      return await this.getPosition(owner, i)
    })
    return Promise.all(positionPromises)
  }

  async getPositionsFromRange(owner: PublicKey, lowerIndex: number, upperIndex: number) {
    try {
      await this.getPositionList(owner)
      return this.getPositionsFromIndexes(
        owner,
        Array.from({ length: upperIndex - lowerIndex + 1 }, (_, i) => i + lowerIndex)
      )
    } catch (e) {
      return []
    }
  }

  async getTickAddress(pair: Pair, index: number) {
    const poolAddress = await pair.getAddress(this.program.programId)
    const indexBuffer = Buffer.alloc(4)
    indexBuffer.writeInt32LE(index)

    const [tickAddress, tickBump] = await PublicKey.findProgramAddress(
      [Buffer.from(utils.bytes.utf8.encode(TICK_SEED)), poolAddress.toBuffer(), indexBuffer],
      this.program.programId
    )

    return {
      tickAddress,
      tickBump
    }
  }

  async getPositionListAddress(owner: PublicKey) {
    const [positionListAddress, positionListBump] = await PublicKey.findProgramAddress(
      [Buffer.from(utils.bytes.utf8.encode(POSITION_LIST_SEED)), owner.toBuffer()],
      this.program.programId
    )

    return {
      positionListAddress,
      positionListBump
    }
  }

  async getPositionAddress(owner: PublicKey, index: number) {
    const indexBuffer = Buffer.alloc(4)
    indexBuffer.writeInt32LE(index)

    const [positionAddress, positionBump] = await PublicKey.findProgramAddress(
      [Buffer.from(utils.bytes.utf8.encode(POSITION_SEED)), owner.toBuffer(), indexBuffer],
      this.program.programId
    )

    return {
      positionAddress,
      positionBump
    }
  }

  async getNewPositionAddress(owner: PublicKey) {
    const positionList = await this.getPositionList(owner)
    return this.getPositionAddress(owner, positionList.head)
  }

  async createFeeTierInstruction(feeTier: FeeTier, admin: PublicKey) {
    const { fee, tickSpacing } = feeTier
    const { address, bump } = await this.getFeeTierAddress(feeTier)
    const ts = tickSpacing ?? feeToTickSpacing(fee)

    return this.program.instruction.createFeeTier(bump, fee, ts, {
      accounts: {
        state: this.stateAddress,
        feeTier: address,
        admin,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      }
    })
  }

  //Test-only usage
  //Admin function
  async createFeeTier({ feeTier, admin }: CreateFeeTier, signer?: Keypair) {
    admin = admin || this.wallet.publicKey 
    const ix = await this.createFeeTierInstruction(feeTier, admin)
    const tx = new Transaction().add(ix)

    if (signer === undefined) {
      this.wallet.signTransaction(tx)
    } else {
      await signAndSend(new Transaction().add(ix), [signer], this.connection)
    }
  }

  async createStateInstruction(admin: PublicKey) {
    const { programAuthority, nonce } = await this.getProgramAuthority()
    const { address, bump } = await this.getStateAddress()

    return this.program.instruction.createState(bump, nonce, {
      accounts: {
        state: address,
        admin,
        programAuthority: programAuthority,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      }
    })
  }

  async createState(admin?: Keypair) {
    const adminPub = admin.publicKey || this.wallet.publicKey
    const ix = await this.createStateInstruction(adminPub)
    const tx = new Transaction().add(ix)

    if (admin === undefined) {
      this.wallet.signTransaction(tx)
    } else {
      await signAndSend(new Transaction().add(ix), [admin], this.connection)
    }
  }

  async getStateAddress() {
    const [address, bump] = await PublicKey.findProgramAddress(
      [Buffer.from(utils.bytes.utf8.encode(STATE_SEED))],
      this.program.programId
    )

    return {
      address,
      bump
    }
  }

  async getState() {
    const address = (await this.getStateAddress()).address
    return (await this.program.account.state.fetch(address)) as State
  }

  async createTickInstruction(pair: Pair, index: number, payer: PublicKey) {
    const state = await this.getPool(pair)
    const { tickAddress, tickBump } = await this.getTickAddress(pair, index)

    return this.program.instruction.createTick(tickBump, index, {
      accounts: {
        tick: tickAddress,
        pool: await pair.getAddress(this.program.programId),
        tickmap: state.tickmap,
        payer,
        tokenX: state.tokenX,
        tokenY: state.tokenY,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      }
    }) as TransactionInstruction
  }

  async createTick({ pair, index, payer }: CreateTick, signer?: Keypair) {
    payer = payer || this.wallet.publicKey
    const ix = await this.createTickInstruction(pair, index, payer)
    const tx = new Transaction().add(ix)
    
    if (signer === undefined) {
      this.wallet.signTransaction(tx)
    } else {
      await signAndSend(new Transaction().add(ix), [signer], this.connection)
    }
  }

  async createTicksFromRange({ pair, payer }: CreateTick, start: number, stop: number, signer?: Keypair) {
    const step = pair.feeTier.tickSpacing ?? feeToTickSpacing(pair.feeTier.fee)

    Promise.all(
      generateTicksArray(start, stop, step).map(async (index) => {
        await this.createTick({pair, index, payer}, signer)
      })
    )
  }

  async createPositionListInstruction(owner: PublicKey) {
    const { positionListAddress, positionListBump } = await this.getPositionListAddress(owner)

    return this.program.instruction.createPositionList(positionListBump, {
      accounts: {
        positionList: positionListAddress,
        owner,
        signer: owner,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      }
    }) as TransactionInstruction
  }

  async createPositionList(owner?: PublicKey, signer?: Keypair) {
    let ownerPub = owner || this.wallet.publicKey
    const ix = await this.createPositionListInstruction(ownerPub)
    const tx = new Transaction().add(ix)
    
    if (signer === undefined) {
      this.wallet.signTransaction(tx)
    } else {
      await signAndSend(new Transaction().add(ix), [signer], this.connection)
    }
  }

  async initPositionInstruction(initPosition: InitPosition, assumeFirstPosition: boolean = false) {
    const { pair, owner, userTokenX, userTokenY, lowerTick, upperTick, liquidityDelta } = initPosition
    const state = await this.getPool(pair)

    // maybe in the future index cloud be store at market
    const { tickAddress: lowerTickAddress } = await this.getTickAddress(pair, lowerTick)
    const { tickAddress: upperTickAddress } = await this.getTickAddress(pair, upperTick)
    const { positionAddress, positionBump } = await this.getPositionAddress(
      owner,
      assumeFirstPosition ? 0 : (await this.getPositionList(owner)).head
    )
    const { positionListAddress } = await this.getPositionListAddress(owner)
    const poolAddress = await pair.getAddress(this.program.programId)
    const tickmapAddress = await this.getTickmap(pair)

    return this.program.instruction.createPosition(
      positionBump,
      lowerTick,
      upperTick,
      liquidityDelta,
      {
        accounts: {
          state: this.stateAddress,
          pool: poolAddress,
          positionList: positionListAddress,
          position: positionAddress,
          tickmap: tickmapAddress,
          owner,
          lowerTick: lowerTickAddress,
          upperTick: upperTickAddress,
          tokenX: pair.tokenX,
          tokenY: pair.tokenY,
          accountX: userTokenX,
          accountY: userTokenY,
          reserveX: state.tokenXReserve,
          reserveY: state.tokenYReserve,
          programAuthority: this.programAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId
        }
      }
    ) as TransactionInstruction
  }

  async initPositionTx(initPosition: InitPosition) {
    const { owner, pair, lowerTick, upperTick } = initPosition

    const [tickmap, pool] = await Promise.all([this.getTickmap(pair), this.getPool(pair)])

    const lowerExists = isInitialized(tickmap, lowerTick, pool.tickSpacing)
    const upperExists = isInitialized(tickmap, upperTick, pool.tickSpacing)

    const tx = new Transaction()

    if (!lowerExists) {
      tx.add(await this.createTickInstruction(pair, lowerTick, owner))
    }
    if (!upperExists) {
      tx.add(await this.createTickInstruction(pair, upperTick, owner))
    }

    const { positionListAddress } = await this.getPositionListAddress(owner)
    const account = await this.connection.getAccountInfo(positionListAddress)

    if (account === null) {
      tx.add(await this.createPositionListInstruction(owner))
      return tx.add(await this.initPositionInstruction(initPosition, true))
    }

    return tx.add(await this.initPositionInstruction(initPosition, false))
  }

  async initPosition(initPosition: InitPosition, signer?: Keypair) {
    initPosition.owner = initPosition.owner || this.wallet.publicKey
    const tx = await this.initPositionTx(initPosition)
    if (signer === undefined) {
      this.wallet.signTransaction(tx)
    } else {
      await signAndSend(tx, [signer], this.connection)
    }
  }

  async swap(swap: Swap, signer?: Keypair, overridePriceLimit?: BN) {
    swap.owner = swap.owner || this.wallet.publicKey
    const ix = await this.swapInstruction(swap, overridePriceLimit)
    const tx = new Transaction().add(ix)

    if (signer === undefined) {
      this.wallet.signTransaction(tx)
    } else {
      await signAndSend(tx, [signer], this.connection)
    }
    
  }

  async swapInstruction(
    swap: Swap,
    overridePriceLimit?: BN
  ) {
    const { pair, owner, XtoY, amount, knownPrice, slippage, accountX, accountY, byAmountIn} = swap
    const pool = await this.getPool(pair)
    const tickmap = await this.getTickmap(pair)

    const priceLimit =
      overridePriceLimit ?? calculatePriceAfterSlippage(knownPrice, slippage, !XtoY).v

    const indexesInDirection = findClosestTicks(
      tickmap.bitmap,
      pool.currentTickIndex,
      pool.tickSpacing,
      15,
      Infinity,
      XtoY ? 'down' : 'up'
    )
    const indexesInReverse = findClosestTicks(
      tickmap.bitmap,
      pool.currentTickIndex,
      pool.tickSpacing,
      3,
      Infinity,
      XtoY ? 'up' : 'down'
    )
    const remainingAccounts = await Promise.all(
      indexesInDirection.concat(indexesInReverse).map(async (index) => {
        const { tickAddress } = await this.getTickAddress(pair, index)
        return tickAddress
      })
    )

    const swapIx = this.program.instruction.swap(XtoY, amount, byAmountIn, priceLimit, {
      remainingAccounts: remainingAccounts.map((pubkey) => {
        return { pubkey, isWritable: true, isSigner: false }
      }),
      accounts: {
        state: this.stateAddress,
        pool: await pair.getAddress(this.program.programId),
        tickmap: pool.tickmap,
        tokenX: pool.tokenX,
        tokenY: pool.tokenY,
        reserveX: pool.tokenXReserve,
        reserveY: pool.tokenYReserve,
        owner,
        accountX,
        accountY,
        programAuthority: this.programAuthority,
        tokenProgram: TOKEN_PROGRAM_ID
      }
    })

    const tx = new Transaction().add(swapIx)
    return tx
  }

  async getReserveBalances(pair: Pair, tokenX: Token, tokenY: Token) {
    const state = await this.getPool(pair)

    const accounts = await Promise.all([
      tokenX.getAccountInfo(state.tokenXReserve),
      tokenY.getAccountInfo(state.tokenYReserve)
    ])

    return { x: accounts[0].amount, y: accounts[1].amount }
  }

  async claimFeeInstruction(claimFee: ClaimFee) {
    const { pair, owner, userTokenX, userTokenY, index } = claimFee
    const state = await this.getPool(pair)
    const { positionAddress } = await this.getPositionAddress(owner, index)
    const position = await this.getPosition(owner, index)
    const { tickAddress: lowerTickAddress } = await this.getTickAddress(
      pair,
      position.lowerTickIndex
    )
    const { tickAddress: upperTickAddress } = await this.getTickAddress(
      pair,
      position.upperTickIndex
    )

    return this.program.instruction.claimFee(
      index,
      position.lowerTickIndex,
      position.upperTickIndex,
      {
        accounts: {
          state: this.stateAddress,
          pool: await pair.getAddress(this.program.programId),
          position: positionAddress,
          lowerTick: lowerTickAddress,
          upperTick: upperTickAddress,
          owner,
          tokenX: pair.tokenX,
          tokenY: pair.tokenY,
          accountX: userTokenX,
          accountY: userTokenY,
          reserveX: state.tokenXReserve,
          reserveY: state.tokenYReserve,
          programAuthority: this.programAuthority,
          tokenProgram: TOKEN_PROGRAM_ID
        }
      }
    ) as TransactionInstruction
  }

  async claimFee(claimFee: ClaimFee, signer?: Keypair) {
    claimFee.owner = claimFee.owner || this.wallet.publicKey
    const ix = await this.claimFeeInstruction(claimFee)
    const tx = new Transaction().add(ix)

    if (signer === undefined) {
      this.wallet.signTransaction(tx)
    } else {
      await signAndSend(tx, [signer], this.connection)
    }
  }

  async withdrawProtocolFeeInstruction(withdrawProtocolFee: WithdrawProtocolFee) {
    const { pair, accountX, accountY, admin } = withdrawProtocolFee
    const pool = await this.getPool(pair)

    return this.program.instruction.withdrawProtocolFee({
      accounts: {
        state: this.stateAddress,
        pool: await pair.getAddress(this.program.programId),
        tokenX: pool.tokenX,
        tokenY: pool.tokenY,
        reserveX: pool.tokenXReserve,
        reserveY: pool.tokenYReserve,
        accountX,
        accountY,
        admin,
        programAuthority: this.programAuthority,
        tokenProgram: TOKEN_PROGRAM_ID
      }
    }) as TransactionInstruction
  }

  //Admin function
  async withdrawProtocolFee(withdrawProtocolFee: WithdrawProtocolFee, signer?: Keypair) {
    withdrawProtocolFee.admin = withdrawProtocolFee.admin || this.wallet.publicKey
    const ix = await this.withdrawProtocolFeeInstruction(withdrawProtocolFee)
    const tx = new Transaction().add(ix)
    
    if (signer === undefined) {
      this.wallet.signTransaction(tx)
    } else {
      await signAndSend(tx, [signer], this.connection)
    }
    
  }

  async removePositionInstruction(removePosition: RemovePosition): Promise<TransactionInstruction> {
    const positionList = await this.getPositionList(removePosition.owner)
    const { pair, owner, index, userTokenX, userTokenY} = removePosition
    const { positionListAddress } = await this.getPositionListAddress(owner)
    const { positionAddress: removedPositionAddress } = await this.getPositionAddress(owner, index)
    const { positionAddress: lastPositionAddress } = await this.getPositionAddress(
      owner,
      positionList.head - 1
    )

    const state = await this.getPool(pair)
    const position = await this.getPosition(owner, index)

    const { tickAddress: lowerTickAddress } = await this.getTickAddress(
      pair,
      position.lowerTickIndex
    )
    const { tickAddress: upperTickAddress } = await this.getTickAddress(
      pair,
      position.upperTickIndex
    )

    return this.program.instruction.removePosition(
      index,
      position.lowerTickIndex,
      position.upperTickIndex,
      {
        accounts: {
          state: this.stateAddress,
          owner: owner,
          removedPosition: removedPositionAddress,
          positionList: positionListAddress,
          lastPosition: lastPositionAddress,
          pool: await pair.getAddress(this.program.programId),
          tickmap: state.tickmap,
          lowerTick: lowerTickAddress,
          upperTick: upperTickAddress,
          tokenX: pair.tokenX,
          tokenY: pair.tokenY,
          accountX: userTokenX,
          accountY: userTokenY,
          reserveX: state.tokenXReserve,
          reserveY: state.tokenYReserve,
          programAuthority: this.programAuthority,
          tokenProgram: TOKEN_PROGRAM_ID
        }
      }
    ) as TransactionInstruction
  }

  async removePosition(removePosition: RemovePosition, signer?: Keypair) {
    removePosition.owner = removePosition.owner || this.wallet.publicKey
    const ix = await this.removePositionInstruction(removePosition)
    const tx = new Transaction().add(ix)

    if (signer === undefined) {
      this.wallet.signTransaction(tx)
    } else {
      signAndSend(tx, [signer], this.connection)
    }
  }

  async transferPositionOwnershipInstruction(transferPositionOwnership: TransferPositionOwnership): Promise<TransactionInstruction> {
    const {owner, recipient, index} = transferPositionOwnership
    const { positionListAddress: ownerList } = await this.getPositionListAddress(owner)
    const { positionListAddress: recipientList } = await this.getPositionListAddress(recipient)

    const ownerPositionList = await this.getPositionList(owner)
    const { positionAddress: removedPosition } = await this.getPositionAddress(owner, index)
    const { positionAddress: lastPosition } = await this.getPositionAddress(
      owner,
      ownerPositionList.head - 1
    )
    const { positionAddress: newPosition, positionBump: newPositionBump } =
      await this.getNewPositionAddress(recipient)

    return this.program.instruction.transferPositionOwnership(newPositionBump, index, {
      accounts: {
        owner,
        recipient,
        ownerList,
        recipientList,
        lastPosition,
        removedPosition,
        newPosition,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      }
    }) as TransactionInstruction
  }

  async transferPositionOwnership(transferPositionOwnership: TransferPositionOwnership, signer?: Keypair) {
    transferPositionOwnership.owner = transferPositionOwnership.owner || this.wallet.publicKey
    const ix = await this.transferPositionOwnershipInstruction(transferPositionOwnership)
    const tx = new Transaction().add(ix)

    if (signer === undefined) {
      this.wallet.signTransaction(tx)
    } else {
      signAndSend(tx, [signer], this.connection)
    }
  }

  async updateSecondsPerLiquidityInstruction(updateSecondsPerLiquidity: UpdateSecondsPerLiquidity) {
    const {pair, owner, lowerTickIndex, upperTickIndex, index } = updateSecondsPerLiquidity
    const { tickAddress: lowerTickAddress } = await this.getTickAddress(pair, lowerTickIndex)
    const { tickAddress: upperTickAddress } = await this.getTickAddress(pair, upperTickIndex)
    const poolAddress = await pair.getAddress(this.program.programId)
    const { positionAddress: positionAddress } = await this.getPositionAddress(
      owner,
      index
    )

    return this.program.instruction.updateSecondsPerLiquidity(
      lowerTickIndex,
      upperTickIndex,
      index,
      {
        accounts: {
          pool: poolAddress,
          lowerTick: lowerTickAddress,
          upperTick: upperTickAddress,
          position: positionAddress,
          tokenX: pair.tokenX,
          tokenY: pair.tokenY,
          owner,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId
        }
      }
    ) as TransactionInstruction
  }

  async initializeOracle(pair: Pair, payer: Keypair) {
    const oracleKeypair = Keypair.generate()
    const poolAddress = await pair.getAddress(this.program.programId)

    return await this.program.rpc.initializeOracle({
      accounts: {
        pool: poolAddress,
        oracle: oracleKeypair.publicKey,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        payer: payer.publicKey,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      },
      signers: [payer, oracleKeypair],
      instructions: [await this.program.account.oracle.createInstruction(oracleKeypair)]
    })
  }

  async getOracle(pair: Pair) {
    const pool = await this.getPool(pair)
    return await this.program.account.oracle.fetch(pool.oracleAddress)
  }
}

export interface Decimal {
  v: BN
}

export interface State {
  protocolFee: Decimal
  admin: PublicKey
  nonce: number
  authority: PublicKey
  bump: number
}

export interface FeeTierStructure {
  fee: Decimal
  tickSpacing: number
  bump: number
}

export interface PoolStructure {
  tokenX: PublicKey
  tokenY: PublicKey
  tokenXReserve: PublicKey
  tokenYReserve: PublicKey
  tickSpacing: number
  fee: Decimal
  liquidity: Decimal
  sqrtPrice: Decimal
  currentTickIndex: number
  tickmap: PublicKey
  feeGrowthGlobalX: Decimal
  feeGrowthGlobalY: Decimal
  feeProtocolTokenX: Decimal
  feeProtocolTokenY: Decimal
  secondsPerLiquidityGlobal: Decimal
  startTimestamp: BN
  lastTimestamp: BN
  oracleAddress: PublicKey
  oracleInitialized: boolean
  bump: number
}

export interface Tickmap {
  bitmap: Array<number>
}
export interface PositionList {
  head: number
  bump: number
}
export interface Tick {
  index: number
  sign: boolean
  liquidityChange: Decimal
  liquidityGross: Decimal
  sqrtPrice: Decimal
  feeGrowthOutsideX: Decimal
  feeGrowthOutsideY: Decimal
  bump: number
}

export interface Position {
  owner: PublicKey
  pool: PublicKey
  id: BN
  liquidity: Decimal
  lowerTickIndex: number
  upperTickIndex: number
  feeGrowthInsideX: Decimal
  feeGrowthInsideY: Decimal
  secondsPerLiquidityInside: Decimal
  lastSlot: BN
  tokensOwedX: Decimal
  tokensOwedY: Decimal
  bump: number
}
export interface FeeTier {
  fee: BN
  tickSpacing?: number
}

export enum Errors {
  ZeroAmount = '0x12c', // 0
  ZeroOutput = '0x12d', // 1
  WrongTick = '0x12e', // 2
  WrongLimit = '0x12f', // 3
  InvalidTickSpacing = '0x130', // 4
  InvalidTickInterval = '0x131', // 5
  NoMoreTicks = '0x132', // 6
  TickNotFound = '0x133', // 7
  PriceLimitReached = '0x134' // 8
}

export interface InitPosition {
  pair: Pair
  owner?: PublicKey
  userTokenX: PublicKey
  userTokenY: PublicKey
  lowerTick: number
  upperTick: number
  liquidityDelta: Decimal
}

export interface ModifyPosition {
  pair: Pair
  owner?: PublicKey
  userTokenX: PublicKey
  userTokenY: PublicKey
  index: number
  liquidityDelta: Decimal
}

export interface CreatePool {
  pair: Pair
  signer: Keypair
  initTick?: number
  protocolFee: Decimal
}
export interface ClaimFee {
  pair: Pair
  owner?: PublicKey
  userTokenX: PublicKey
  userTokenY: PublicKey
  index: number
}
export interface Swap {
  pair: Pair
  owner?: PublicKey
  XtoY: boolean
  amount: BN
  knownPrice: Decimal
  slippage: Decimal
  accountX: PublicKey
  accountY: PublicKey
  byAmountIn: boolean
}
export interface UpdateSecondsPerLiquidity {
  pair: Pair
  owner?: PublicKey
  lowerTickIndex: number
  upperTickIndex: number
  index: number
}
export interface CreateFeeTier {
  feeTier: FeeTier,
  admin?: PublicKey
}
export interface CreateTick {
  pair: Pair,
  index: number,
  payer?: PublicKey
}
export interface WithdrawProtocolFee {
  pair: Pair,
  accountX: PublicKey,
  accountY: PublicKey,
  admin?: PublicKey
}
export interface RemovePosition {
  pair: Pair,
  owner?: PublicKey,
  index: number,
  userTokenX: PublicKey,
  userTokenY: PublicKey
}
export interface TransferPositionOwnership {
  owner?: PublicKey,
  recipient: PublicKey,
  index: number
}