/**
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

'use strict';

var assert = require('assert');
var extend = require('extend');
var mockery = require('mockery');
var nodeutil = require('util');

var util = require('../../lib/common/util.js');
var ServiceObject = require('../../lib/common/service-object.js');

function FakeIAM() {
  this.calledWith_ = [].slice.call(arguments);
}

function FakeServiceObject() {
  this.calledWith_ = arguments;
  ServiceObject.apply(this, arguments);
}

nodeutil.inherits(FakeServiceObject, ServiceObject);

describe('Topic', function() {
  var Topic;
  var topic;

  var PROJECT_ID = 'test-project';
  var TOPIC_NAME = 'test-topic';
  var PUBSUB = {
    projectId: PROJECT_ID,
    createTopic: util.noop
  };

  before(function() {
    mockery.registerMock('../common/service-object.js', FakeServiceObject);
    mockery.registerMock('./iam', FakeIAM);

    mockery.enable({
      useCleanCache: true,
      warnOnUnregistered: false
    });

    Topic = require('../../lib/pubsub/topic');
  });

  after(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  beforeEach(function() {
    topic = new Topic(PUBSUB, TOPIC_NAME);
  });

  describe('initialization', function() {
    it('should inherit from ServiceObject', function(done) {
      var pubsubInstance = extend({}, PUBSUB, {
        createTopic: {
          bind: function(context) {
            assert.strictEqual(context, pubsubInstance);
            done();
          }
        }
      });

      var topic = new Topic(pubsubInstance, TOPIC_NAME);
      assert(topic instanceof ServiceObject);

      var calledWith = topic.calledWith_[0];

      assert.strictEqual(calledWith.parent, pubsubInstance);
      assert.strictEqual(calledWith.baseUrl, '/topics');
      assert.strictEqual(calledWith.id, TOPIC_NAME);
      assert.deepEqual(calledWith.methods, {
        create: true,
        delete: true,
        exists: true,
        get: true,
        getMetadata: true
      });
    });

    it('should create an iam object', function() {
      assert.deepEqual(topic.iam.calledWith_, [
        PUBSUB,
        {
          baseUrl: '/topics',
          id: TOPIC_NAME
        }
      ]);
    });

    it('should format name', function(done) {
      var formatName_ = Topic.formatName_;
      Topic.formatName_ = function() {
        Topic.formatName_ = formatName_;
        done();
      };
      new Topic(PUBSUB, TOPIC_NAME);
    });

    it('should assign pubsub object to `this`', function() {
      assert.deepEqual(topic.pubsub, PUBSUB);
    });
  });

  describe('formatMessage_', function() {
    var messageString = 'string';
    var messageBuffer = new Buffer(messageString);

    var messageObjectWithString = { data: messageString };
    var messageObjectWithBuffer = { data: messageBuffer };

    it('should handle string data', function() {
      assert.deepEqual(
        Topic.formatMessage_(messageObjectWithString),
        { data: new Buffer(JSON.stringify(messageString)).toString('base64') }
      );
    });

    it('should handle buffer data', function() {
      assert.deepEqual(
        Topic.formatMessage_(messageObjectWithBuffer),
        { data: messageBuffer.toString('base64') }
      );
    });
  });

  describe('formatName_', function() {
    var fullName = 'projects/' + PROJECT_ID + '/topics/' + TOPIC_NAME;

    it('should format name', function() {
      var formattedName = Topic.formatName_(PROJECT_ID, TOPIC_NAME);
      assert.equal(formattedName, fullName);
    });

    it('should format name when given a complete name', function() {
      var formattedName = Topic.formatName_(PROJECT_ID, fullName);
      assert.equal(formattedName, fullName);
    });
  });

  describe('getSubscriptions', function() {
    it('should accept just a callback', function(done) {
      topic.pubsub.getSubscriptions = function(options, callback) {
        assert.deepEqual(options, { topic: topic });
        callback();
      };

      topic.getSubscriptions(done);
    });

    it('should pass correct args to pubsub#getSubscriptions', function(done) {
      var opts = { a: 'b', c: 'd' };

      topic.pubsub = {
        getSubscriptions: function(options, callback) {
          assert.deepEqual(options, opts);
          assert.deepEqual(options.topic, topic);
          callback();
        }
      };

      topic.getSubscriptions(opts, done);
    });
  });

  describe('publish', function() {
    var message = 'howdy';
    var messageObject = { data: message };

    it('should throw if no message is provided', function() {
      assert.throws(function() {
        topic.publish();
      }, /Cannot publish without a message/);

      assert.throws(function() {
        topic.publish([]);
      }, /Cannot publish without a message/);
    });

    it('should throw if a message has no data', function() {
      assert.throws(function() {
        topic.publish({});
      }, /Cannot publish message without a `data` property/);
    });

    it('should send correct api request', function(done) {
      topic.request = function(reqOpts) {
        assert.strictEqual(reqOpts.method, 'POST');
        assert.strictEqual(reqOpts.uri, ':publish');
        assert.deepEqual(reqOpts.json, {
          messages: [
            { data: new Buffer(JSON.stringify(message)).toString('base64') }
          ]
        });
        done();
      };

      topic.publish(messageObject, assert.ifError);
    });

    it('should execute callback', function(done) {
      topic.request = function(reqOpts, callback) {
        callback(null, {});
      };

      topic.publish(messageObject, done);
    });

    it('should execute callback with error', function(done) {
      var error = new Error('Error.');
      var apiResponse = {};

      topic.request = function(reqOpts, callback) {
        callback(error, apiResponse);
      };

      topic.publish(messageObject, function(err, ackIds, apiResponse_) {
        assert.strictEqual(err, error);
        assert.strictEqual(ackIds, null);
        assert.strictEqual(apiResponse_, apiResponse);

        done();
      });
    });

    it('should execute callback with apiResponse', function(done) {
      var resp = { success: true };

      topic.request = function(reqOpts, callback) {
        callback(null, resp);
      };

      topic.publish(messageObject, function(err, ackIds, apiResponse) {
        assert.deepEqual(resp, apiResponse);
        done();
      });
    });
  });

  describe('subscribe', function() {
    it('should pass correct arguments to pubsub#subscribe', function(done) {
      var subscriptionName = 'subName';
      var opts = {};

      topic.pubsub.subscribe = function(t, subName, options, callback) {
        assert.deepEqual(t, topic);
        assert.equal(subName, subscriptionName);
        assert.deepEqual(options, opts);
        callback();
      };

      topic.subscribe(subscriptionName, opts, done);
    });
  });

  describe('subscription', function() {
    it('should pass correct arguments to pubsub#subscription', function(done) {
      var subscriptionName = 'subName';
      var opts = {};

      topic.pubsub.subscription = function(name, options) {
        assert.equal(name, subscriptionName);
        assert.deepEqual(options, opts);
        done();
      };

      topic.subscription(subscriptionName, opts);
    });

    it('should attach the topic instance to the options', function(done) {
      topic.pubsub.subscription = function(name, options) {
        assert.strictEqual(options.topic, topic);
        done();
      };

      topic.subscription();
    });

    it('should return the result', function(done) {
      topic.pubsub.subscription = function() {
        return done;
      };

      var doneFn = topic.subscription();
      doneFn();
    });
  });
});
