/**
 * Copyright 2015 Google Inc. All Rights Reserved.
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

var util = require('../../lib/common/util.js');

var makeAuthenticatedRequestFactoryCache = util.makeAuthenticatedRequestFactory;
var makeAuthenticatedRequestFactoryOverride;
util.makeAuthenticatedRequestFactory = function() {
  if (makeAuthenticatedRequestFactoryOverride) {
    return makeAuthenticatedRequestFactoryOverride.apply(this, arguments);
  } else {
    return makeAuthenticatedRequestFactoryCache.apply(this, arguments);
  }
};

describe('Service', function() {
  var Service;
  var service;

  var CONFIG = {
    scopes: [],
    baseUrl: 'base-url',
    projectIdRequired: false
  };

  var OPTIONS = {
    credentials: {},
    keyFile: {},
    email: 'email',
    projectId: 'project-id',
  };

  before(function() {
    mockery.registerMock('./util.js', util);

    mockery.enable({
      useCleanCache: true,
      warnOnUnregistered: false
    });

    Service = require('../../lib/common/service.js');
  });

  after(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  beforeEach(function() {
    makeAuthenticatedRequestFactoryOverride = null;
    service = new Service(CONFIG, OPTIONS);
  });

  describe('instantiation', function() {
    it('should create an authenticated request factory', function() {
      var authenticatedRequest = {};

      makeAuthenticatedRequestFactoryOverride = function(config) {
        assert.strictEqual(config.scopes, CONFIG.scopes);
        assert.strictEqual(config.credentials, OPTIONS.credentials);
        assert.strictEqual(config.keyFile, OPTIONS.keyFilename);
        assert.strictEqual(config.email, OPTIONS.email);

        return authenticatedRequest;
      };

      var svc = new Service(CONFIG, OPTIONS);
      assert.strictEqual(svc.makeAuthenticatedRequest, authenticatedRequest);
    });

    it('should localize the authClient', function() {
      var authClient = {};

      makeAuthenticatedRequestFactoryOverride = function() {
        return {
          authClient: authClient
        };
      };

      var service = new Service(CONFIG, OPTIONS);
      assert.strictEqual(service.authClient, authClient);
    });

    it('should localize the baseUrl', function() {
      assert.strictEqual(service.baseUrl, CONFIG.baseUrl);
    });

    it('should localize the getCredentials method', function() {
      function getCredentials() {}

      makeAuthenticatedRequestFactoryOverride = function() {
        return {
          authClient: {},
          getCredentials: getCredentials
        };
      };

      var service = new Service(CONFIG, OPTIONS);
      assert.strictEqual(service.getCredentials, getCredentials);
    });

    it('should localize the projectId', function() {
      assert.strictEqual(service.projectId, OPTIONS.projectId);
    });

    it('should localize the projectIdRequired', function() {
      assert.strictEqual(service.projectIdRequired, CONFIG.projectIdRequired);
    });

    it('should default projectIdRequired to true', function() {
      var service = new Service({}, OPTIONS);
      assert.strictEqual(service.projectIdRequired, true);
    });
  });

  describe('request', function() {
    var reqOpts;

    beforeEach(function() {
      reqOpts = {
        uri: 'uri'
      };
    });

    it('should send the right request to the parent', function(done) {
      service.makeAuthenticatedRequest = function(reqOpts_, callback) {
        assert.strictEqual(reqOpts_, reqOpts);
        callback(); // done()
      };

      service.request(reqOpts, done);
    });

    it('should compose the correct uri', function(done) {
      var expectedUri = [
        service.baseUrl,
        reqOpts.uri
      ].join('/');

      service.makeAuthenticatedRequest = function(reqOpts_) {
        assert.strictEqual(reqOpts_.uri, expectedUri);
        done();
      };

      service.request(reqOpts, assert.ifError);
    });

    it('should trim slashes', function(done) {
      var reqOpts = {
        uri: '//1/2//'
      };

      var expectedUri = [
        service.baseUrl,
        '1/2'
      ].join('/');

      service.makeAuthenticatedRequest = function(reqOpts_) {
        assert.strictEqual(reqOpts_.uri, expectedUri);
        done();
      };

      service.request(reqOpts, assert.ifError);
    });

    it('should replace path/:subpath with path:subpath', function(done) {
      var reqOpts = {
        uri: ':test'
      };

      var expectedUri = service.baseUrl + reqOpts.uri;

      service.makeAuthenticatedRequest = function(reqOpts_) {
        assert.strictEqual(reqOpts_.uri, expectedUri);
        done();
      };

      service.request(reqOpts, assert.ifError);
    });

    describe('projectIdRequired', function() {
      describe('false', function() {
        it('should include the projectId', function(done) {
          var config = extend({}, CONFIG, { projectIdRequired: false });
          var service = new Service(config, OPTIONS);

          var expectedUri = [
            service.baseUrl,
            reqOpts.uri
          ].join('/');

          service.makeAuthenticatedRequest = function(reqOpts_) {
            assert.strictEqual(reqOpts_.uri, expectedUri);

            done();
          };

          service.request(reqOpts, assert.ifError);
        });
      });

      describe('true', function() {
        it('should not include the projectId', function(done) {
          var config = extend({}, CONFIG, { projectIdRequired: true });
          var service = new Service(config, OPTIONS);

          var expectedUri = [
            service.baseUrl,
            'projects',
            service.projectId,
            reqOpts.uri
          ].join('/');

          service.makeAuthenticatedRequest = function(reqOpts_) {
            assert.strictEqual(reqOpts_.uri, expectedUri);

            done();
          };

          service.request(reqOpts, assert.ifError);
        });
      });
    });
  });
});
