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

var arrify = require('arrify');
var assert = require('assert');
var extend = require('extend');
var mockery = require('mockery');
var nodeutil = require('util');
var request = require('request');

var Service = require('../../lib/common/service.js');
var Topic = require('../../lib/pubsub/topic.js');
var util = require('../../lib/common/util.js');

var SubscriptionCached = require('../../lib/pubsub/subscription.js');
var SubscriptionOverride;

function Subscription(a, b) {
  var OverrideFn = SubscriptionOverride || SubscriptionCached;
  return new OverrideFn(a, b);
}

var requestCached = request;
var requestOverride;
function fakeRequest() {
  return (requestOverride || requestCached).apply(null, arguments);
}
fakeRequest.defaults = function() {
  // Ignore the default values, so we don't have to test for them in every API
  // call.
  return fakeRequest;
};

var fakeUtil = extend({}, util);

function FakeService() {
  this.calledWith_ = arguments;
  Service.apply(this, arguments);
}

nodeutil.inherits(FakeService, Service);

var extended = false;
var fakeStreamRouter = {
  extend: function(Class, methods) {
    if (Class.name !== 'PubSub') {
      return;
    }

    methods = arrify(methods);
    assert.equal(Class.name, 'PubSub');
    assert.deepEqual(methods, ['getSubscriptions', 'getTopics']);
    extended = true;
  }
};

describe('PubSub', function() {
  var PubSub;
  var PROJECT_ID = 'test-project';
  var pubsub;

  before(function() {
    mockery.registerMock('../common/service.js', FakeService);
    mockery.registerMock('../common/stream-router.js', fakeStreamRouter);
    mockery.registerMock('../common/util.js', fakeUtil);
    mockery.registerMock('./subscription.js', Subscription);
    mockery.registerMock('./topic.js', Topic);
    mockery.registerMock('request', fakeRequest);

    mockery.enable({
      useCleanCache: true,
      warnOnUnregistered: false
    });

    PubSub = require('../../lib/pubsub');
  });

  after(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  beforeEach(function() {
    SubscriptionOverride = null;
    requestOverride = null;
    pubsub = new PubSub({ projectId: PROJECT_ID });
    pubsub.request = function(method, path, q, body, callback) {
      callback();
    };
  });

  describe('instantiation', function() {
    it('should extend the correct methods', function() {
      assert(extended); // See `fakeStreamRouter.extend`
    });

    it('should normalize the arguments', function() {
      var normalizeArguments = fakeUtil.normalizeArguments;
      var normalizeArgumentsCalled = false;
      var fakeOptions = { projectId: PROJECT_ID };
      var fakeContext = {};

      fakeUtil.normalizeArguments = function(context, options) {
        normalizeArgumentsCalled = true;
        assert.strictEqual(context, fakeContext);
        assert.strictEqual(options, fakeOptions);
        return options;
      };

      PubSub.call(fakeContext, fakeOptions);
      assert(normalizeArgumentsCalled);

      fakeUtil.normalizeArguments = normalizeArguments;
    });

    it('should inherit from Service', function() {
      assert(pubsub instanceof Service);

      var calledWith = pubsub.calledWith_[0];

      var baseUrl = 'https://pubsub.googleapis.com/v1';
      assert.strictEqual(calledWith.baseUrl, baseUrl);
      assert.deepEqual(calledWith.scopes, [
        'https://www.googleapis.com/auth/pubsub',
        'https://www.googleapis.com/auth/cloud-platform'
      ]);
    });
  });

  describe('createTopic', function() {
    it('should make the correct API request', function(done) {
      var topicName = 'new-topic-name';

      pubsub.request = function(reqOpts) {
        assert.strictEqual(reqOpts.method, 'PUT');
        assert.strictEqual(reqOpts.uri, '/topics/' + topicName);
        done();
      };

      pubsub.createTopic(topicName, function() {});
    });

    describe('error', function() {
      var error = new Error('Error.');
      var apiResponse = {};

      beforeEach(function() {
        pubsub.request = function(reqOpts, callback) {
          callback(error, apiResponse);
        };
      });

      it('should return an error & API response', function(done) {
        pubsub.createTopic('new-topic', function(err, topic, apiResponse_) {
          assert.strictEqual(err, error);
          assert.strictEqual(topic, null);
          assert.strictEqual(apiResponse_, apiResponse);
          done();
        });
      });
    });

    describe('success', function() {
      var apiResponse = {};

      beforeEach(function() {
        pubsub.request = function(reqOpts, callback) {
          callback(null, apiResponse);
        };
      });

      it('should return a Topic object', function(done) {
        var topicName = 'new-topic';
        var topicInstance = {};

        pubsub.topic = function(name) {
          assert.strictEqual(name, topicName);
          return topicInstance;
        };

        pubsub.createTopic(topicName, function(err, topic) {
          assert.ifError(err);
          assert.strictEqual(topic, topicInstance);
          done();
        });
      });

      it('should pass apiResponse to callback', function(done) {
        pubsub.createTopic('new-topic', function(err, topic, apiResponse_) {
          assert.ifError(err);
          assert.strictEqual(apiResponse_, apiResponse);
          done();
        });
      });
    });
  });

  describe('getSubscriptions', function() {
    beforeEach(function() {
      pubsub.request = function(reqOpts, callback) {
        callback(null, { subscriptions: [{ name: 'fake-subscription' }] });
      };
    });

    it('should accept a query and a callback', function(done) {
      pubsub.getSubscriptions({}, done);
    });

    it('should accept just a callback', function(done) {
      pubsub.getSubscriptions(done);
    });

    it('should pass the correct arguments to the API', function(done) {
      pubsub.request = function(reqOpts) {
        assert.strictEqual(reqOpts.uri, '/subscriptions');
        assert.deepEqual(reqOpts.qs, {});
        done();
      };

      pubsub.getSubscriptions(assert.ifError);
    });

    describe('topics', function() {
      var TOPIC;
      var TOPIC_NAME = 'topic';
      var TOPIC_SUBCRIPTION_NAME = '/topics/' + TOPIC_NAME + '/subscriptions';

      before(function() {
        TOPIC = new Topic(pubsub, TOPIC_NAME);
      });

      it('should subscribe to a topic by string', function(done) {
        pubsub.request = function(reqOpts) {
          assert.equal(reqOpts.uri, TOPIC_SUBCRIPTION_NAME);
          done();
        };

        pubsub.getSubscriptions({ topic: TOPIC_NAME }, assert.ifError);
      });

      it('should subscribe to a topic by Topic instance', function(done) {
        pubsub.request = function(reqOpts) {
          assert.strictEqual(reqOpts.uri, TOPIC_SUBCRIPTION_NAME);
          done();
        };

        pubsub.getSubscriptions({ topic: TOPIC }, assert.ifError);
      });
    });

    it('should pass options to API request', function(done) {
      var opts = { pageSize: 10, pageToken: 'abc' };

      pubsub.request = function(reqOpts) {
        assert.strictEqual(reqOpts.qs.pageSize, opts.pageSize);
        assert.strictEqual(reqOpts.qs.pageToken, opts.pageToken);
        done();
      };

      pubsub.getSubscriptions(opts, assert.ifError);
    });

    it('should pass error & response if api returns an error', function(done) {
      var error = new Error('Error');
      var resp = { error: true };

      pubsub.request = function(reqOpts, callback) {
        callback(error, resp);
      };

      pubsub.getSubscriptions(function(err, subs, nextQuery, apiResponse) {
        assert.equal(err, error);
        assert.deepEqual(apiResponse, resp);
        done();
      });
    });

    describe('returning Subscription instances', function() {
      it('should handle subscriptions.list response', function(done) {
        pubsub.getSubscriptions(function(err, subscriptions) {
          assert.ifError(err);
          assert(subscriptions[0] instanceof SubscriptionCached);
          done();
        });
      });

      it('should handle topics.subscriptions.list response', function(done) {
        var subName = 'sub-name';
        var subFullName =
          'projects/' + PROJECT_ID + '/subscriptions/' + subName;

        pubsub.request = function(reqOpts, callback) {
          callback(null, { subscriptions: [subName] });
        };

        pubsub.getSubscriptions(function(err, subscriptions) {
          assert.ifError(err);
          assert(subscriptions[0] instanceof SubscriptionCached);
          assert.equal(subscriptions[0].name, subFullName);
          done();
        });
      });
    });

    it('should return a query if more results exist', function() {
      var token = 'next-page-token';

      pubsub.request = function(reqOpts, callback) {
        callback(null, { nextPageToken: token });
      };

      var query = { maxResults: 1 };

      pubsub.getSubscriptions(query, function(err, subscriptions, nextQuery) {
        assert.ifError(err);
        assert.strictEqual(query.maxResults, nextQuery.maxResults);
        assert.equal(query.pageToken, token);
      });
    });

    it('should pass apiResponse to callback', function(done) {
      var resp = { success: true };

      pubsub.request = function(reqOpts, callback) {
        callback(null, resp);
      };

      pubsub.getSubscriptions(function(err, subs, nextQuery, apiResponse) {
        assert.equal(resp, apiResponse);
        done();
      });
    });
  });

  describe('getTopics', function() {
    var topicName = 'fake-topic';
    var apiResponse = { topics: [{ name: topicName }]};

    beforeEach(function() {
      pubsub.request = function(reqOpts, callback) {
        callback(null, apiResponse);
      };
    });

    it('should accept a query and a callback', function(done) {
      pubsub.getTopics({}, done);
    });

    it('should accept just a callback', function(done) {
      pubsub.getTopics(done);
    });

    it('should build the right request', function(done) {
      pubsub.request = function(reqOpts) {
        assert.equal(reqOpts.uri, '/topics');
        done();
      };
      pubsub.getTopics(function() {});
    });

    it('should return Topic instances with metadata', function(done) {
      var topic = {};

      pubsub.topic = function(name) {
        assert.strictEqual(name, topicName);
        return topic;
      };

      pubsub.getTopics(function(err, topics) {
        assert.ifError(err);
        assert.strictEqual(topics[0], topic);
        assert.strictEqual(topics[0].metadata, apiResponse.topics[0]);
        done();
      });
    });

    it('should return a query if more results exist', function() {
      var token = 'next-page-token';
      pubsub.request = function(reqOpts, callback) {
        callback(null, { nextPageToken: token });
      };
      var query = { pageSize: 1 };
      pubsub.getTopics(query, function(err, topics, nextQuery) {
        assert.ifError(err);
        assert.strictEqual(query.pageSize, nextQuery.pageSize);
        assert.equal(query.pageToken, token);
      });
    });

    it('should pass error if api returns an error', function() {
      var error = new Error('Error');
      pubsub.request = function(reqOpts, callback) {
        callback(error);
      };
      pubsub.getTopics(function(err) {
        assert.equal(err, error);
      });
    });

    it('should pass apiResponse to callback', function(done) {
      var resp = { success: true };
      pubsub.request = function(reqOpts, callback) {
        callback(null, resp);
      };
      pubsub.getTopics(function(err, topics, nextQuery, apiResponse) {
        assert.equal(resp, apiResponse);
        done();
      });
    });
  });

  describe('subscribe', function() {
    var TOPIC_NAME = 'topic';
    var TOPIC = {
      name: '/topics/' + TOPIC_NAME
    };

    var SUB_NAME = 'subscription';
    var SUBSCRIPTION = {
      name: '/subscriptions/' + SUB_NAME
    };

    var apiResponse = {
      name: 'subscription-name'
    };

    it('should throw if no Topic is provided', function() {
      assert.throws(function() {
        pubsub.subscribe();
      }, /A Topic is required.*/);
    });

    it('should throw if no sub name is provided', function() {
      assert.throws(function() {
        pubsub.subscribe('topic');
      }, /A subscription name is required.*/);
    });

    it('should not require configuration options', function(done) {
      pubsub.request = function(reqOpts, callback) {
        callback(null, apiResponse);
      };

      pubsub.subscribe(TOPIC_NAME, SUB_NAME, done);
    });

    it('should create a topic object from a string', function(done) {
      pubsub.request = util.noop;

      pubsub.topic = function(topicName) {
        assert.strictEqual(topicName, TOPIC_NAME);
        setImmediate(done);
        return TOPIC;
      };

      pubsub.subscribe(TOPIC_NAME, SUB_NAME, assert.ifError);
    });

    it('should send correct request', function(done) {
      pubsub.topic = function(topicName) {
        return {
          name: topicName
        };
      };

      pubsub.request = function(reqOpts) {
        assert.strictEqual(reqOpts.method, 'PUT');
        assert.strictEqual(reqOpts.uri, SUBSCRIPTION.name);
        assert.strictEqual(reqOpts.json.topic, TOPIC_NAME);
        done();
      };

      pubsub.subscribe(TOPIC_NAME, SUB_NAME, assert.ifError);
    });

    it('should pass options to the api request', function(done) {
      var options = {
        autoAck: true,
        interval: 3,
        reuseExisting: false,
        ackDeadlineSeconds: 90,
        pushConfig: {
          pushEndpoint: 'https://domain/push'
        }
      };

      var expectedBody = extend({}, options, {
        topic: TOPIC_NAME
      });

      delete expectedBody.autoAck;
      delete expectedBody.interval;
      delete expectedBody.reuseExisting;

      pubsub.topic = function() {
        return {
          name: TOPIC_NAME
        };
      };

      pubsub.request = function(reqOpts) {
        assert.notStrictEqual(reqOpts.json, options);
        assert.deepEqual(reqOpts.json, expectedBody);
        done();
      };

      pubsub.subscribe(TOPIC_NAME, SUB_NAME, options, assert.ifError);
    });

    describe('error', function() {
      var error = new Error('Error.');
      var apiResponse = { name: SUB_NAME };

      beforeEach(function() {
        pubsub.request = function(reqOpts, callback) {
          callback(error, apiResponse);
        };
      });

      it('should re-use existing subscription if specified', function(done) {
        pubsub.subscription = function() {
          return SUBSCRIPTION;
        };

        pubsub.request = function(reqOpts, callback) {
          callback({ code: 409 }, apiResponse);
        };

        // Don't re-use an existing subscription (error if one exists).
        pubsub.subscribe(TOPIC_NAME, SUB_NAME, function(err) {
          assert.equal(err.code, 409);
        });

        // Re-use an existing subscription (ignore error if one exists).
        var opts = { reuseExisting: true };
        pubsub.subscribe(TOPIC_NAME, SUB_NAME, opts, function(err, sub) {
          assert.ifError(err);
          assert.deepEqual(sub, SUBSCRIPTION);

          done();
        });
      });

      it('should return error & API response to the callback', function(done) {
        pubsub.request = function(reqOpts, callback) {
          callback(error, apiResponse);
        };

        pubsub.subscribe(TOPIC_NAME, SUB_NAME, function(err, sub, resp) {
          assert.strictEqual(err, error);
          assert.strictEqual(sub, null);
          assert.strictEqual(resp, apiResponse);
          done();
        });
      });
    });

    describe('success', function() {
      var apiResponse = { name: SUB_NAME };

      beforeEach(function() {
        pubsub.request = function(reqOpts, callback) {
          callback(null, apiResponse);
        };
      });

      it('should pass options to a new subscription object', function(done) {
        var opts = { a: 'b', c: 'd' };

        pubsub.subscription = function(subName, options) {
          assert.strictEqual(subName, SUB_NAME);
          assert.deepEqual(options, opts);
          setImmediate(done);
          return SUBSCRIPTION;
        };

        pubsub.subscribe(TOPIC_NAME, SUB_NAME, opts, assert.ifError);
      });

      it('should return apiResponse to the callback', function(done) {
        pubsub.request = function(reqOpts, callback) {
          callback(null, apiResponse);
        };

        pubsub.subscribe(TOPIC_NAME, SUB_NAME, function(err, sub, resp) {
          assert.strictEqual(resp, apiResponse);
          done();
        });
      });
    });
  });

  describe('subscription', function() {
    var SUB_NAME = 'new-sub-name';
    var CONFIG = { autoAck: true, interval: 90 };

    it('should throw if no name is provided', function() {
      assert.throws(function() {
        pubsub.subscription();
      }, /The name of a subscription is required/);
    });

    it('should return a Subscription object', function() {
      SubscriptionOverride = function() {};
      var subscription = pubsub.subscription(SUB_NAME, {});
      assert(subscription instanceof SubscriptionOverride);
    });

    it('should honor settings', function(done) {
      SubscriptionOverride = function(pubsub, options) {
        assert.deepEqual(options, CONFIG);
        done();
      };
      pubsub.subscription(SUB_NAME, CONFIG);
    });

    it('should pass specified name to the Subscription', function(done) {
      SubscriptionOverride = function(pubsub, options) {
        assert.equal(options.name, SUB_NAME);
        done();
      };
      pubsub.subscription(SUB_NAME, {});
    });

    it('should not require options', function() {
      assert.doesNotThrow(function() {
        pubsub.subscription(SUB_NAME);
      });
    });
  });

  describe('topic', function() {
    it('should throw if a name is not provided', function() {
      assert.throws(function() {
        pubsub.topic();
      }, /name must be specified/);
    });

    it('should return a Topic object', function() {
      assert(pubsub.topic('new-topic') instanceof Topic);
    });
  });
});
