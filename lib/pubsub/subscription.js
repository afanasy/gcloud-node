/*!
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*!
 * @module pubsub/subscription
 */

'use strict';

var arrify = require('arrify');
var events = require('events');
var is = require('is');
var modelo = require('modelo');
var prop = require('propprop');

/**
 * @type {module:pubsub/iam}
 * @private
 */
var IAM = require('./iam.js');

/**
 * @type {module:common/serviceObject}
 * @private
 */
var ServiceObject = require('../common/service-object.js');

/**
 * @type {module:common/util}
 * @private
 */
var util = require('../common/util.js');

/*! Developer Documentation
 *
 * @param {module:pubsub} pubsub - PubSub object.
 * @param {object} options - Configuration object.
 * @param {boolean} options.autoAck - Automatically acknowledge the message
 *     once it's pulled. (default: false)
 * @param {number} options.interval - Interval in milliseconds to check for new
 *     messages. (default: 10)
 * @param {string} options.name - Name of the subscription.
 * @param {number} options.maxInProgress - Maximum messages to consume
 *     simultaneously.
 */
/**
 * A Subscription object will give you access to your Google Cloud Pub/Sub
 * subscription.
 *
 * Subscriptions are sometimes retrieved when using various methods:
 *
 * - {@linkcode module:pubsub#getSubscriptions}
 * - {@linkcode module:pubsub/topic#getSubscriptions}
 * - {@linkcode module:pubsub/topic#subscribe}
 *
 * Subscription objects may be created directly with:
 *
 * - {@linkcode module:pubsub/topic#subscription}
 *
 * All Subscription objects are instances of an
 * [EventEmitter](http://nodejs.org/api/events.html). The subscription will pull
 * for messages automatically as long as there is at least one listener assigned
 * for the `message` event.
 *
 * @alias module:pubsub/subscription
 * @constructor
 *
 * @example
 * var pubsub = gcloud.pubsub({
 *   projectId: 'grape-spaceship-123'
 * });
 *
 * //-
 * // From {@linkcode module:pubsub#getSubscriptions}:
 * //-
 * pubsub.getSubscriptions(function(err, subscriptions) {
 *   // `subscriptions` is an array of Subscription objects.
 * });
 *
 * //-
 * // From {@linkcode module:pubsub/topic#getSubscriptions}:
 * //-
 * var topic = pubsub.topic('my-topic');
 * topic.getSubscriptions(function(err, subscriptions) {
 *   // `subscriptions` is an array of Subscription objects.
 * });
 *
 * //-
 * // From {@linkcode module:pubsub/topic#subscribe}:
 * //-
 * var topic = pubsub.topic('my-topic');
 * topic.subscribe('new-subscription', function(err, subscription) {
 *   // `subscription` is a Subscription object.
 * });
 *
 * //-
 * // From {@linkcode module:pubsub/topic#subscription}:
 * //-
 * var topic = pubsub.topic('my-topic');
 * var subscription = topic.subscription('my-subscription');
 * // `subscription` is a Subscription object.
 *
 * //-
 * // Once you have obtained a subscription object, you may begin to register
 * // listeners. This will automatically trigger pulling for messages.
 * //-
 * // Register an error handler.
 * subscription.on('error', function(err) {});
 *
 * // Register a listener for `message` events.
 * function onMessage(message) {
 *   // Called every time a message is received.
 *
 *   // message.id = ID of the message.
 *   // message.ackId = ID used to acknowledge the message receival.
 *   // message.data = Contents of the message.
 *
 *   // Ack the message:
 *   // message.ack(callback);
 *
 *   // Skip the message. This is useful with `maxInProgress` option when
 *   // creating your subscription. This doesn't ack the message, but allows
 *   // more messages to be retrieved if your limit was hit.
 *   // message.skip();
 * }
 * subscription.on('message', onMessage);
 *
 * // Remove the listener from receiving `message` events.
 * subscription.removeListener('message', onMessage);
 */
function Subscription(pubsub, options) {
  var baseUrl = '/subscriptions';
  var unformattedName = options.name.split('/').pop();

  var methods = {
    /**
     * Check if the subscription exists.
     *
     * @param {function} callback - The callback function.
     * @param {?error} callback.err - An error returned while making this
     *     request.
     * @param {boolean} callback.exists - Whether the subscription exists or
     *     not.
     *
     * @example
     * subscription.exists(function(err, exists) {});
     */
    exists: true,

    /**
     * Get a subscription if it exists.
     *
     * You may optionally use this to "get or create" an object by providing an
     * object with `autoCreate` set to `true`. Any extra configuration that is
     * normally required for the `create` method must be contained within this
     * object as well.
     *
     * **`autoCreate` is only available if you accessed this object
     * through {module:pubsub/topic#subscription}.**
     *
     * @param {options=} options - Configuration object.
     * @param {boolean} options.autoCreate - Automatically create the object if
     *     it does not exist. Default: `false`
     *
     * @example
     * subscription.get(function(err, subscription, apiResponse) {
     *   // `subscription.metadata` has been populated.
     * });
     */
    get: true,

    /**
     * Get the metadata for the subscription.
     *
     * @resource [Subscriptions: get API Documentation]{@link https://cloud.google.com/pubsub/reference/rest/v1/projects.subscriptions/get}
     *
     * @param {function} callback - The callback function.
     * @param {?error} callback.err - An API error.
     * @param {?object} callback.metadata - Metadata of the subscription from
     *     the API.
     * @param {object} callback.apiResponse - Raw API response.
     *
     * @example
     * subscription.getMetadata(function(err, metadata, apiResponse) {});
     */
    getMetadata: true
  };

  var config = {
    parent: pubsub,
    baseUrl: baseUrl,
    id: unformattedName,
    methods: methods
  };

  if (options.topic) {
    // Only a subscription with knowledge of its topic can be created.
    config.createMethod = pubsub.subscribe.bind(pubsub, options.topic);
    delete options.topic;

    /**
     * Create a subscription.
     *
     * **This is only available if you accessed this object through
     * {module:pubsub/topic#subscription}.**
     *
     * @param {object} config - See {module:pubsub#subscribe}.
     *
     * @example
     * subscription.create(function(err, subscription, apiResponse) {
     *   if (!err) {
     *     // The subscription was created successfully.
     *   }
     * });
     */
    config.methods.create = true;
  }

  ServiceObject.call(this, config);
  events.EventEmitter.call(this);

  /**
   * [IAM (Identity and Access Management)](https://cloud.google.com/pubsub/access_control)
   * allows you to set permissions on invidual resources and offers a wider
   * range of roles: editor, owner, publisher, subscriber, and viewer. This
   * gives you greater flexibility and allows you to set more fine-grained
   * access control.
   *
   * *The IAM access control features described in this document are Beta,
   * including the API methods to get and set IAM policies, and to test IAM
   * permissions. Google Cloud Pub/Sub's use of IAM features is not covered by
   * any SLA or deprecation policy, and may be subject to backward-incompatible
   * changes.*
   *
   * @mixes module:pubsub/iam
   *
   * @resource [Access Control Overview]{@link https://cloud.google.com/pubsub/access_control}
   * @resource [What is Cloud IAM?]{@link https://cloud.google.com/iam/}
   *
   * @example
   * //-
   * // Get the IAM policy for your subscription.
   * //-
   * subscription.iam.getPolicy(function(err, policy) {
   *   console.log(policy);
   * });
   */
  this.iam = new IAM(pubsub, {
    baseUrl: baseUrl,
    id: unformattedName
  });

  this.name = Subscription.formatName_(pubsub.projectId, options.name);

  this.autoAck = is.boolean(options.autoAck) ? options.autoAck : false;
  this.closed = true;
  this.interval = is.number(options.interval) ? options.interval : 10;
  this.inProgressAckIds = {};
  this.maxInProgress =
    is.number(options.maxInProgress) ? options.maxInProgress : Infinity;
  this.messageListeners = 0;
  this.paused = false;

  this.listenForEvents_();
}

modelo.inherits(Subscription, ServiceObject, events.EventEmitter);

/**
 * Simplify a message from an API response to have three properties, `id`,
 * `data` and `attributes`. `data` is always converted to a string.
 *
 * @private
 */
Subscription.formatMessage_ = function(msg) {
  var innerMessage = msg.message;
  var message = {
    ackId: msg.ackId
  };

  if (innerMessage) {
    message.id = innerMessage.messageId;

    if (innerMessage.data) {
      message.data = new Buffer(innerMessage.data, 'base64').toString('utf-8');

      try {
        message.data = JSON.parse(message.data);
      } catch(e) {}
    }

    if (innerMessage.attributes) {
      message.attributes = innerMessage.attributes;
    }
  }

  return message;
};

/**
 * Format the name of a subscription. A subscription's full name is in the
 * format of projects/{projectId}/subscriptions/{subName}.
 *
 * @private
 */
Subscription.formatName_ = function(projectId, name) {
  // Simple check if the name is already formatted.
  if (name.indexOf('/') > -1) {
    return name;
  }

  return 'projects/' + projectId + '/subscriptions/' + name;
};

/**
 * Acknowledge to the backend that the message was retrieved. You must provide
 * either a single ackId or an array of ackIds.
 *
 * @resource [Subscriptions: acknowledge API Documentation]{@link https://cloud.google.com/pubsub/reference/rest/v1/projects.subscriptions/acknowledge}
 *
 * @throws {Error} If at least one ackId is not provided.
 *
 * @param {string|string[]} ackIds - An ackId or array of ackIds.
 * @param {function=} callback - The callback function.
 *
 * @example
 * subscription.ack('ePHEESyhuE8e...', function(err, apiResponse) {});
 */
Subscription.prototype.ack = function(ackIds, callback) {
  var self = this;

  ackIds = arrify(ackIds);

  if (ackIds.length === 0) {
    throw new Error([
      'At least one ID must be specified before it can be acknowledged.'
    ].join(''));
  }

  callback = callback || util.noop;

  this.request({
    method: 'POST',
    uri: ':acknowledge',
    json: {
      ackIds: ackIds
    }
  }, function(err, resp) {
    if (!err) {
      ackIds.forEach(function(ackId) {
        delete self.inProgressAckIds[ackId];
      });

      self.refreshPausedStatus_();
    }

    callback(err, resp);
  });
};

/**
 * Add functionality on top of a message returned from the API, including the
 * ability to `ack` and `skip` the message.
 *
 * This also records the message as being "in progress". See
 * {module:subscription#refreshPausedStatus_}.
 *
 * @private
 *
 * @param {object} message - A message object.
 * @return {object} message - The original message after being decorated.
 * @param {function} message.ack - Ack the message.
 * @param {function} message.skip - Increate the number of available messages to
 *     simultaneously receive.
 */
Subscription.prototype.decorateMessage_ = function(message) {
  var self = this;

  this.inProgressAckIds[message.ackId] = true;

  message.ack = self.ack.bind(self, message.ackId);

  message.skip = function() {
    delete self.inProgressAckIds[message.ackId];
    self.refreshPausedStatus_();
  };

  return message;
};

/**
 * Delete the subscription. Pull requests from the current subscription will be
 * errored once unsubscription is complete.
 *
 * @resource [Subscriptions: delete API Documentation]{@link https://cloud.google.com/pubsub/reference/rest/v1/projects.subscriptions/delete}
 *
 * @param {function=} callback - The callback function.
 *
 * @example
 * subscription.delete(function(err, apiResponse) {});
 */
Subscription.prototype.delete = function(callback) {
  var self = this;

  callback = callback || util.noop;

  ServiceObject.prototype.delete.call(this, function(err, resp) {
    if (err) {
      callback(err, resp);
      return;
    }

    self.closed = true;
    self.removeAllListeners();

    callback(null, resp);
  });
};

/**
 * Pull messages from the subscribed topic. If messages were found, your
 * callback is executed with an array of message objects.
 *
 * Note that messages are pulled automatically once you register your first
 * event listener to the subscription, thus the call to `pull` is handled for
 * you. If you don't want to start pulling, simply don't register a
 * `subscription.on('message', function() {})` event handler.
 *
 * @todo Should not be racing with other pull.
 *
 * @resource [Subscriptions: pull API Documentation]{@link https://cloud.google.com/pubsub/reference/rest/v1/projects.subscriptions/pull}
 *
 * @param {object=} options - Configuration object.
 * @param {boolean} options.returnImmediately - If set, the system will respond
 *     immediately. Otherwise, wait until new messages are available. Returns if
 *     timeout is reached.
 * @param {number} options.maxResults - Limit the amount of messages pulled.
 * @param {function} callback - The callback function.
 *
 * @example
 * //-
 * // Pull all available messages.
 * //-
 * subscription.pull(function(err, messages) {
 *   // messages = [
 *   //   {
 *   //     ackId: '',     // ID used to acknowledge its receival.
 *   //     id: '',        // Unique message ID.
 *   //     data: '',      // Contents of the message.
 *   //     attributes: {} // Attributes of the message.
 *   //
 *   //     Helper functions:
 *   //     ack(callback): // Ack the message.
 *   //     skip():        // Free up 1 slot on the sub's maxInProgress value.
 *   //   },
 *   //   // ...
 *   // ]
 * });
 *
 * //-
 * // Pull a single message.
 * //-
 * var opts = {
 *   maxResults: 1
 * };
 *
 * subscription.pull(opts, function(err, messages, apiResponse) {});
 */
Subscription.prototype.pull = function(options, callback) {
  var self = this;
  var MAX_EVENTS_LIMIT = 1000;

  if (!callback) {
    callback = options;
    options = {};
  }

  if (!is.number(options.maxResults)) {
    options.maxResults = MAX_EVENTS_LIMIT;
  }

  this.request({
    method: 'POST',
    uri: ':pull',
    json: {
      returnImmediately: !!options.returnImmediately,
      maxMessages: options.maxResults
    }
  }, function(err, response) {
    if (err) {
      callback(err, null, response);
      return;
    }

    var messages = arrify(response.receivedMessages)
      .map(Subscription.formatMessage_)
      .map(self.decorateMessage_.bind(self));

    self.refreshPausedStatus_();

    if (self.autoAck && messages.length !== 0) {
      var ackIds = messages.map(prop('ackId'));

      self.ack(ackIds, function(err) {
        callback(err, messages, response);
      });
    } else {
      callback(null, messages, response);
    }
  });
};

/**
 * Modify the ack deadline for a specific message. This method is useful to
 * indicate that more time is needed to process a message by the subscriber, or
 * to make the message available for redelivery if the processing was
 * interrupted.
 *
 * @resource [Subscriptions: modifyAckDeadline API Documentation]{@link https://cloud.google.com/pubsub/reference/rest/v1/projects.subscriptions/modifyAckDeadline}
 *
 * @param {object} options - The configuration object.
 * @param {number|number[]} options.ackIds - The ack id(s) to change.
 * @param {number} options.seconds - Number of seconds after call is made to
 *     set the deadline of the ack.
 * @param {Function=} callback - The callback function.
 *
 * @example
 * var options = {
 *   ackIds: [123],
 *   seconds: 10 // Expire in 10 seconds from call.
 * };
 *
 * subscription.setAckDeadline(options, function(err, apiResponse) {});
 */
Subscription.prototype.setAckDeadline = function(options, callback) {
  callback = callback || util.noop;

  this.request({
    method: 'POST',
    uri: ':modifyAckDeadline',
    json: {
      ackIds: arrify(options.ackIds),
      ackDeadlineSeconds: options.seconds
    }
  }, function(err, resp) {
    callback(err, resp);
  });
};

/**
 * Begin listening for events on the subscription. This method keeps track of
 * how many message listeners are assigned, and then removed, making sure
 * polling is handled automatically.
 *
 * As long as there is one active message listener, the connection is open. As
 * soon as there are no more message listeners, the connection is closed.
 *
 * @private
 *
 * @example
 * subscription.listenForEvents_();
 */
Subscription.prototype.listenForEvents_ = function() {
  var self = this;

  this.on('newListener', function(event) {
    if (event === 'message') {
      self.messageListeners++;
      if (self.closed) {
        self.closed = false;
        self.startPulling_();
      }
    }
  });

  this.on('removeListener', function(event) {
    if (event === 'message' && --self.messageListeners === 0) {
      self.closed = true;
    }
  });
};

/**
 * Update the status of `maxInProgress`. Å subscription becomes "paused" (not
 * pulling) when the number of messages that have yet to be ack'd or skipped
 * exceeds the user's specified `maxInProgress` value.
 *
 * This will start pulling when that event reverses: we were paused, but one or
 * more messages were just ack'd or skipped, freeing up room for more messages
 * to be consumed.
 *
 * @private
 */
Subscription.prototype.refreshPausedStatus_ = function() {
  var isCurrentlyPaused = this.paused;
  var inProgress = Object.keys(this.inProgressAckIds).length;

  this.paused = inProgress >= this.maxInProgress;

  if (isCurrentlyPaused && !this.paused && this.messageListeners > 0) {
    this.startPulling_();
  }
};

/**
 * Poll the backend for new messages. This runs a loop to ping the API at the
 * provided interval from the subscription's instantiation. If one wasn't
 * provided, the default value is 10 milliseconds.
 *
 * If messages are received, they are emitted on the `message` event.
 *
 * Note: This method is automatically called once a message event handler is
 * assigned to the description.
 *
 * To stop pulling, see {@linkcode module:pubsub/subscription#close}.
 *
 * @private
 *
 * @example
 * subscription.startPulling_();
 */
Subscription.prototype.startPulling_ = function() {
  var self = this;

  if (this.closed || this.paused) {
    return;
  }

  var maxResults;

  if (this.maxInProgress < Infinity) {
    maxResults = this.maxInProgress - Object.keys(this.inProgressAckIds).length;
  }

  this.pull({
    returnImmediately: false,
    maxResults: maxResults
  }, function(err, messages, apiResponse) {
    if (err) {
      self.emit('error', err, apiResponse);
    }

    if (messages) {
      messages.forEach(function(message) {
        self.emit('message', message, apiResponse);
      });
    }

    setTimeout(self.startPulling_.bind(self), self.interval);
  });
};

module.exports = Subscription;
