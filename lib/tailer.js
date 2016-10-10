'use strict'

const
  util       = require('util'),
  mongodb    = require('mongodb').MongoClient,
  Timestamp  = require('mongodb').Timestamp,
  MySQL      = require('./mysql.js'),
  createDefs = require('./defs.js')

/**
 * Tailer
 * @class
 */
class Tailer {
  /**
   * Constructor
   * @param {object} config - configulation options
   */
  constructor (config) {
    this.url    = config.src || 'mongodb://localhost:27017/test'
    this.url2   = this.url.replace(/\/\w+(\?|$)/, '/local$1')
    this.dbName = this.url.split(/\/|\?/)[3]
    this.defs   = createDefs(config.collections, this.dbName, config.prefix, config.fieldCase)
    this.lastTs = 0
    this.mysql  = new MySQL(config.dist, this.defs)
  }

  /** Start tailing **/
  start () {
    this.mysql.readTimestamp()
      .then(ts => this.updateTimestamp(ts, true))
      .then(() => this.tailForever())
      .catch(err => this.stop(err))
  }

  /** Import all and start tailing **/
  importAndStart () {
    this.mysql.createTable()
      .then(() => this.importAll())
      .then(() => this.updateTimestamp())
      .then(() => this.tailForever())
      .catch(err => this.stop(err))
  }

  stop (err) {
    if (err) util.log(err)
    util.log('Bye')
    process.exit()
  }

  /**
   * Import all
   * @returns {Promise} with no value
   */
  importAll () {
    util.log('Begin to import...')
    let promise = Promise.resolve()
    this.defs.forEach(def => {
      promise = promise.then(() => this.importCollection(def))
    })
    promise.then(() => {
      util.log('Done.')
    })
    return promise
  }

  /**
   * Import collection
   * @param {object} def - definition of fields
   * @returns {Promise} with no value
   */
  importCollection (def) {
    util.log(`Import records in ${ def.ns }`)
    return new Promise(resolve =>
      mongodb.connect(this.url, { 'auto_reconnect': true })
        .then(db => {
          const stream = db.collection(def.name).find().stream()
          stream
            .on('data', item => {
              stream.pause()
              this.mysql.insert(def, item, () => stream.resume())
            })
            .on('end', () => {
              resolve()
            })
        }))
  }

  /**
   * Check the latest log in Mongo, then catch the timestamp up in MySQL
   * @param {number} ts - unless null then skip updating in MySQL
   * @param {boolean} skipUpdateMySQL - skip update in MySQL
   * @returns {Promise} with no value
   */
  updateTimestamp (ts, skipUpdateMySQL) {
    if (ts) {
      this.lastTs = ts
      if (!skipUpdateMySQL) this.mysql.updateTimestamp(ts)
      return Promise.resolve()
    }
    return new Promise(resolve =>
      mongodb.connect(this.url2, { 'auto_reconnect': true })
        .then(db =>
          db.collection('oplog.rs').find().sort({ $natural: -1 }).limit(1)
            .nextObject()
            .then(item => {
              ts = item.ts.toNumber()
              this.lastTs = ts
              if (!skipUpdateMySQL) this.mysql.updateTimestamp(ts)
              resolve()
            })))
  }

  /**
   * Tail forever
   * @returns {Promise} with no value
   */
  tailForever () {
    return new Promise((resolve, reject) => {
      let counter = 0
      let promise = Promise.resolve()
      const chainPromise = () => {
        promise = promise
          .then(() => {
            const message = counter++
              ? 'Reconnect to MongoDB...'
              : 'Connect to MongoDB...'
            util.log(message)
            return this.tail()
          })
          .catch(err => reject(err))
          .then(chainPromise)
      }
      chainPromise()
    })
  }

  /**
   * Tail the log of Mongo by tailable cursors
   * @returns {Promise} with no value
   */
  tail () {
    const
      ts  = this.lastTs,
      nss = this.defs.map(def => def.ns),
      filters = {
        ns: { $in: nss },
        ts: { $gt: Timestamp.fromNumber(ts) }
      },
      curOpts = {
        tailable: true,
        awaitdata: true,
        numberOfRetries: 60 * 60 * 24,//Number.MAX_VALUE,
        tailableRetryInterval: 1000
      }

    util.log(`Begin to watch... (from ${ ts })`)
    return new Promise((resolve, reject) =>
      mongodb.connect(this.url2).then(db => {
        const stream = db.collection('oplog.rs').find(filters, curOpts).stream()
        stream
          .on('data', log => {
            if (log.op == 'n' || log.ts.toNumber() == ts) return
            this.process(log)
          })
          .on('close', () => {
            util.log('Stream closed....')
            db.close()
            resolve()
          })
          .on('error', err => {
            db.close()
            reject(err)
          })
      }))
  }

  /**
   * Process the log and sync to MySQL
   * @param {object} log - the log retrieved from oplog.rs
   * @returns {undefined}
   */
  process (log) {
    const def = this.defs.filter(def => log.ns == def.ns)[0]
    if (!def) return

    this.updateTimestamp(log.ts.toNumber())
    switch (log.op) {
      case 'i':
        util.log(`Insert a new record into ${ def.ns }`)
        return this.mysql.insert(def, log.o)
      case 'u':
        util.log(`Update a record in ${ def.ns } (${ def.idName }=${ log.o2[def.idName] })`)
        return this.mysql.update(def, log.o2[def.idName], log.o.$set, log.o.$unset)
      case 'd':
        util.log(`Delete a record in ${ def.ns } (${ def.idName }=${ log.o[def.idName] })`)
        return this.mysql.remove(def, log.o[def.idName])
      default:
        return
    }
  }
}

module.exports = Tailer
