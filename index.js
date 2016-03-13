var EventEmitter = require('events').EventEmitter
var util = require('util')
var DEBUG = true
var console = global.console
var PREFIX = '[channel] '
var DEBUG = DEBUG || true

function Channel (opts) {
  EventEmitter.call(this)

  opts = opts || {}

  this.id = opts.id || 'channel_' + randomId()

  this.name = opts.name || this.id

  this.prefix = '[' + this.name + '] '

  // accept, called before allowing receive to proceed
  this.accept = opts.accept || this.accept

  // handler for incomming calls
  this.handler = opts.handler

  // emitter for incomming events
  this.emitter = opts.emitter || this

  // automatically set output channel on first input message
  this.setOutputOnFirstInput = true
  if (opts.setOutputOnFirstInput !== undefined) {
    this.setOutputOnFirstInput = opts.setOutputOnFirstInput
  }

  // setup timeout value
  this.timeout = opts.timeout || 1000
  this.timeoutCheckInterval = opts.timeoutCheckInterval || 100
  this._timeoutInterval = undefined

  // input with optional filter
  if (opts.input) {
    this.setInput(opts.input, opts.filter)
  }

  // output
  if (opts.output) {
    this.setOutput(opts.output)
  }

  // internals
  this._call_id = 0
  this._calls = {}

  this.connected = false
}

util.inherits(Channel, EventEmitter)

// ----------------------------------------------------------------------------

Channel.prototype.setInput = function (input, filter) {
  if (input === undefined) {
    return
  }
  var self = this
  DEBUG && console.log(PREFIX + self.prefix + 'set input', input, filter)
  if (this.input) {
    var x = this.input
    DEBUG && console.log(PREFIX + self.prefix + 'WARN - channel input already set', x)
  }

  var messageHandler = function (event) {
    // DEBUG && console.log(PREFIX + PREFIX, 'message event', event)
    var pass = filter === undefined || filter(self, input, event)
    DEBUG && console.log(PREFIX + self.prefix + ' inbound message filter', pass, event)
    if (pass) {
      if (self.setOutputOnFirstInput && self.output === undefined) {
        self.setOutput(event.source, event.origin)
      }
      self._receive(event.data, event)
    }
  }
  if (input.on !== undefined) {
    DEBUG && console.log(PREFIX + self.prefix + 'input is emitter, add on("message")')
    // handle case were input is event emitter
    self.input = input
    input.on('message', messageHandler)
  } else if (input.addEventListener) {
    // or case where its a window object
    DEBUG && console.log(PREFIX + self.prefix + 'input has addEventListener, add message event listener')
    self.input = input
    input.addEventListener('message', messageHandler)
  } else {
    throw new Error('unsupported input type, must be message emitter or event source')
  }
}

Channel.prototype.setOutput = function (output, targetOrigin) {
  if (output === undefined) {
    return
  }
  if (this.output) {
    var x = this.output
    DEBUG && console.log(PREFIX + this.prefix + 'WARN - channel output already set', x)
  }
  var self = this
  self._targetOrigin = targetOrigin
  if (output.postMessage !== undefined) {
    self.output = function (message, targetOrigin) {
      output.postMessage(message, targetOrigin || (self._targetOrigin || '*'))
    }
  } else {
    self.output = output
  }
}

Channel.prototype.connect = function (timeout) {
  var self = this
  return new Promise(function (resolve, reject) {
    self.call('__connect__', [self.id, self.name], timeout).then(function (id, name) {
      if (!self.connected) {
        self.connected = true
        self.emit('connected', id)
      }
      resolve()
    }).catch(function (err) {
      DEBUG && console.log(PREFIX + err)
      if (self.connected) {
        self.connected = false
        self.emit('disconnected')
      }
      reject(err)
    })
  })
}

Channel.prototype.fire = function (type, data) {
  DEBUG && DEBUG && console.log(PREFIX + 'fire', type, data)
  this._send({
    event: {
      type: type,
      data: data
    }
  })
}

Channel.prototype.call = function (name, args, timeout) {
  if (this._call_id === undefined) {
    this._call_id = 0
    this._calls = {}
  }
  var self = this
  timeout = timeout || self.timeout
  this._call_id++
  var id = this._call_id

  return new Promise(function (resolve, reject) {
    // q: does this need wrapping in try/catch => reject or is that automatic?

    process.nextTick(function () {
      self._send({
        call: {
          id: id,
          method: name,
          args: args
        }
      })

      // if we have timeout set and we are not running the checker start it
      if (timeout && self._timeoutInterval === undefined) {
        // the check will automatically stop when no more pending tasks
        self._timeoutInterval = setInterval(self._timeoutCheck.bind(self), self.timeoutCheckInterval)
      }
    })

    var timestamp = (new Date()).getTime()
    DEBUG && console.log(PREFIX + self.prefix + 'adding call', timestamp, id)
    self._calls[id] = {
      resolve: resolve,
      reject: reject,
      timestamp: timestamp,
      timeout: timeout
    }
    DEBUG && console.log(PREFIX + 'calls', self._calls[id])
  })
}

// --------------------------------------------------------------------------------------

Channel.prototype._send = function (msg) {
  var self = this
  var data = JSON.stringify(msg)
  // DEBUG && DEBUG && console.log(PREFIX + 'send', data)
  if (this.output !== undefined) {
    if (this.output.send !== undefined) {
      this.output.send(data)
    } else {
      this.output(data)
    }
  } else {
    DEBUG && console.log(PREFIX + self.prefix + 'unable to post message to target', this.output)
  }
}

Channel.prototype._receive = function (data) {
  var msg = JSON.parse(data)
  return this._handle(msg)
}

Channel.prototype._handle = function (msg) {
  DEBUG && console.log(PREFIX + this.prefix + 'handle message', msg)
  if (msg.event) {
    this._handleEvent(msg.event)
  } else if (msg.call) {
    this._handleCall(msg.call)
  } else if (msg.result) {
    this._handleResult(msg.result)
  }
}

Channel.prototype._handleEvent = function (event) {
  // DEBUG && console.log(PREFIX + 'got event', msg.event, this.handler)
  if (this.emitter.emit) {
    this.emitter.emit(event.type, event.data)
  } else {
    DEBUG && console.log(PREFIX + this.prefix + 'unable to emit event', event)
  }
}

Channel.prototype._handleCall = function (call) {
  // handle incomming calls
  var self = this
  self.emit('call', call)
  try {
    // DEBUG && console.log(PREFIX + call.method, this.handler[call.method])

    var value

    // handle internal calls first
    if (call.method === '__connect__') {
      self.emit('connection')
      value = [self.id, self.name]
    } else {
      // otherwise call handler
      value = self.handler[call.method].apply(self.handler, call.args)
    }

    // check if we got a promise
    if (value && value.then && typeof value.then === 'function') {
      // lots like we have a promise..
      value.then(function (value) {
        // send back result
        self._send({
          result: {
            id: call.id,
            value: value
          }
        })
      }).catch(function (err) {
        // catch any errors
        self._send({
          result: {
            id: call.id,
            error: err.toString()
          }
        })
      })
    } else {
      // otherwise we normal response
      this._send({
        result: {
          id: call.id,
          value: value
        }
      })
    }
  } catch (e) {
    // anything goes wrong, return error
    this._send({
      result: {
        id: call.id,
        error: e.toString()
      }
    })
  }
}

Channel.prototype._handleResult = function (result) {
  var self = this
  var pending = this._calls[result.id]
  if (!pending) {
    // if not found, drop
    DEBUG && console.log(PREFIX + self.prefix + 'no handler for result', result.id)
    return
  }
  if (result.value !== undefined) {
    // if we have value, call resolve
    pending.resolve(result.value)
  } else if (result.error) {
    // in case of error, call reject
    pending.reject(new Error(result.error))
  }
  // remove the handler since we have processed it
  delete this._calls[result.id]
}

Channel.prototype._timeoutCheck = function () {
  var self = this
  // DEBUG && console.log(PREFIX + self.prefix + 'checking for timeout')
  var now = (new Date()).getTime()
  var hasPending = false
  for (var id in this._calls) {
    hasPending = true
    var pending = this._calls[id]
    // DEBUG && console.log(PREFIX + (now - pending.timestamp))
    if ((now - pending.timestamp) > pending.timeout) {
      DEBUG && console.log(PREFIX + self.prefix + 'timeout!')
      pending.reject(new Error(self.prefix + 'call timeout'))
      delete this._calls[id]
    }
  }
  if (!hasPending) {
    // DEBUG && console.log(PREFIX + PREFIX + 'stop timeout check')
    // stop this checker task
    clearInterval(self._timeoutInterval)
    delete self._timeoutInterval
  }
}

function randomId () {
  return (new Date()).getTime().toString().substring(4) + Math.round(Math.random() * 100000).toString()
}

module.exports = Channel
