const {CeloContract} = require('@celo/contractkit')
const ethers = require('ethers')
const {parseUnits, formatUnits} = ethers.utils
const BigNumber = ethers.BigNumber
const PromiEvent = require('web3-core-promievent')
const {min, max} = require('./utils')

class Transaction {
  constructor(tx, manager) {
    Object.assign(this, manager)
    this.manager = manager
    this.tx = {...tx, from: manager.address}
    this._promise = PromiEvent()
    this._emitter = this._promise.eventEmitter
    this.executed = false
    this.retries = 0
    this.currentTxHash = null
    // store all submitted hashes to catch cases when an old tx is mined
    this.hashes = []
  }

  /**
   * Submits the transaction to Ethereum network. Resolves when tx gets enough confirmations.
   * Emits progress events.
   */
  send() {
    if (this.executed) {
      throw new Error('The transaction was already executed')
    }
    this.executed = true
    this._execute().then(this._promise.resolve).catch(this._promise.reject)
    return this._emitter
  }

  /**
   * Replaces a pending tx.
   *
   * @param tx Transaction to send
   */
  async replace(tx) {
    // todo throw error if the current transaction is mined already
    console.log('Replacing current transaction')
    if (!this.executed) {
      // Tx was not executed yet, just replace it
      this.tx = {...tx}
      return
    }
    if (!tx.gasLimit) {
      tx.gasLimit = await this._kit.web3.eth.estimateGas(tx)
      tx.gasLimit = Math.floor(tx.gasLimit * this.config.GAS_LIMIT_MULTIPLIER)
      tx.gasLimit = Math.min(tx.gasLimit, this.config.BLOCK_GAS_LIMIT)
    }
    tx.nonce = this.tx.nonce // can be different from `this.manager._nonce`
    tx.gasPrice = Math.max(this.tx.gasPrice, tx.gasPrice || 0) // start no less than current tx gas price

    this.tx = {...tx}
    this._increaseGasPrice()
    await this._send()
  }

  /**
   * Cancels a pending tx.
   */
  cancel() {
    console.log('Canceling the transaction')
    return this.replace({
      from: this.address,
      to: this.address,
      value: 0,
      gasLimit: 21000,
    })
  }

  /**
   * Executes the transaction. Acquires global mutex for transaction duration
   *
   * @returns {Promise<TransactionReceipt>}
   * @private
   */
  async _execute() {
    const mutexRelease = await this.manager._mutex.acquire()
    try {
      await this._prepare()
      await this._send()
      // we could have bumped nonce during execution, so get the latest one + 1
      this.manager._nonce = this.tx.nonce + 1
      return this.receipt
    } finally {
      mutexRelease()
    }
  }

  /**
   * Prepare first transaction before submitting it. Inits `gas`, `gasPrice`, `nonce`
   *
   * @returns {Promise<void>}
   * @private
   */
  async _prepare() {
    if (!this.config.BLOCK_GAS_LIMIT) {
      const lastBlock = await this._kit.web3.eth.getBlock('latest')
      this.config.BLOCK_GAS_LIMIT = Math.floor(lastBlock.gasLimit.toNumber() * 0.95)
    }

    if (!this.tx.gasLimit || this.config.ESTIMATE_GAS) {
      const gas = await this._kit.web3.eth.estimateGas(this.tx)
      if (!this.tx.gasLimit) {
        const gasLimit = Math.floor(gas * this.config.GAS_LIMIT_MULTIPLIER)
        this.tx.gasLimit = Math.min(gasLimit, this.config.BLOCK_GAS_LIMIT)
      }
    }
    if (!this.tx.gasPrice) {
      const fastGasPrice = BigNumber.from(await this._getGasPrice(1.3))
      const maxGasPrice = parseUnits(this.config.MAX_GAS_PRICE.toString(), 'gwei')
      this.tx.gasPrice = min(fastGasPrice, maxGasPrice).toHexString()
    }
    if (!this.manager._nonce) {
      this.manager._nonce = await this._getLastNonce()
    }
    this.tx.nonce = this.manager._nonce
    this.tx.chainId = await this._kit.web3.eth.getChainId()
  }

  /**
   * Send the current transaction
   *
   * @returns {Promise}
   * @private
   */
  async _send() {
    // todo throw is we attempt to send a tx that attempts to replace already mined tx
    const signedTx = await this._kit.sendTransaction(this.tx)
    this.submitTimestamp = Date.now()
    const txHash = await signedTx.getHash()
    this.hashes.push(txHash)
    this.receipt = await signedTx.waitReceipt()

    this._emitter.emit('transactionHash', txHash)
    console.log(`Broadcasted transaction ${txHash}`)
  }

  _increaseGasPrice() {
    const maxGasPrice = parseUnits(this.config.MAX_GAS_PRICE.toString(), 'gwei')
    const minGweiBump = parseUnits(this.config.MIN_GWEI_BUMP.toString(), 'gwei')
    const oldGasPrice = BigNumber.from(this.tx.gasPrice)
    if (oldGasPrice.gte(maxGasPrice)) {
      console.log('Already at max gas price, not bumping')
      return false
    }
    const newGasPrice = max(
      oldGasPrice.mul(100 + this.config.GAS_BUMP_PERCENTAGE).div(100),
      oldGasPrice.add(minGweiBump),
    )
    this.tx.gasPrice = min(newGasPrice, maxGasPrice).toHexString()
    console.log(`Increasing gas price to ${formatUnits(this.tx.gasPrice, 'gwei')} gwei`)
    return true
  }

  /**
   * Fetches gas price from the oracle
   *
   * @param {>1.0} wiggle. Multiplier on the minimum gas price
   * @returns {Promise<string>} A hex string representing gas price in wei
   * @private
   */
  async _getGasPrice(wiggle) {
    const decimals = 18

    const goldTokenAddress = await this._kit.registry.addressFor(CeloContract.GoldToken)
    const gasPriceMinimumContract = await this._kit.contracts.getGasPriceMinimum()
    const gasPriceMinimum = await gasPriceMinimumContract.getGasPriceMinimum(goldTokenAddress)
    const gasPrice = gasPriceMinimum * wiggle // in CELO
    console.log(`Gas price (@${wiggle}) is now ${gasPrice / Math.pow(10, decimals)} CELO`)
    return parseUnits(gasPrice.toString(), decimals).toHexString()
  }

  /**
   * Gets current nonce for the current account, ignoring any pending transactions
   *
   * @returns {Promise<number>}
   * @private
   */
  _getLastNonce() {
    return this._kit.web3.eth.getTransactionCount(this.address)
  }
}

module.exports = Transaction
