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
 * @module datastore/dataset
 */

'use strict';

var arrify = require('arrify');
var is = require('is');
var nodeutil = require('util');

/**
 * @type {module:datastore/entity}
 * @private
 */
var entity = require('./entity.js');

/**
 * @type {module:datastore/query}
 * @private
 */
var Query = require('./query.js');

/**
 * @type {module:datastore/transaction}
 * @private
 */
var Transaction = require('./transaction.js');

/**
 * @type {module:common/util}
 * @private
 */
var util = require('../common/util.js');

/**
 * @type {module:datastore/request}
 * @private
 */
var DatastoreRequest = require('./request.js');

/**
 * Scopes for Google Datastore access.
 * @const {array} SCOPES
 * @private
 */
var SCOPES = [
  'https://www.googleapis.com/auth/datastore',
  'https://www.googleapis.com/auth/userinfo.email'
];

/**
 * Interact with a dataset from the
 * [Google Cloud Datastore](https://developers.google.com/datastore/).
 *
 * @constructor
 * @alias module:datastore/dataset
 * @mixes module:datastore/request
 *
 * @param {object=} options - [Configuration object](#/docs/?method=gcloud).
 * @param {string=} options.apiEndpoint - Override the default API endpoint used
 *     to reach Datastore. This is useful for connecting to your local Datastore
 *     server (usually "http://localhost:8080").
 * @param {string} options.namespace - Namespace to isolate transactions to.
 *
 * @example
 * var datastore = gcloud.datastore;
 *
 * var dataset = datastore.dataset({
 *   projectId: 'my-project',
 *   keyFilename: '/path/to/keyfile.json'
 * });
 *
 * //-
 * // Connect to your local Datastore server.
 * //-
 * var dataset = datastore.dataset({
 *   projectId: 'my-project',
 *   apiEndpoint: 'http://localhost:8080'
 * });
 *
 * //-
 * // The `process.env.DATASTORE_HOST` environment variable is also recognized.
 * // If set, you may omit the `apiEndpoint` option.
 * //-
 */
function Dataset(options) {
  if (!(this instanceof Dataset)) {
    return new Dataset(options);
  }

  options = options || {};

  if (!options.projectId) {
    throw util.missingProjectIdError;
  }

  this.determineApiEndpoint_(options.apiEndpoint);
  this.namespace = options.namespace;
  this.projectId = options.projectId;

  this.makeAuthenticatedRequest_ = util.makeAuthenticatedRequestFactory({
    customEndpoint: this.customEndpoint,
    credentials: options.credentials,
    keyFile: options.keyFilename,
    scopes: SCOPES,
    email: options.email
  });
}

nodeutil.inherits(Dataset, DatastoreRequest);

/**
 * Determine the appropriate endpoint to use for API requests. If not explicitly
 * defined, check for the "DATASTORE_HOST" environment variable, used to connect
 * to a local Datastore server.
 *
 * @private
 *
 * @param {string} customApiEndpoint - Custom API endpoint.
 */
Dataset.prototype.determineApiEndpoint_ = function(customApiEndpoint) {
  var apiEndpoint;
  var trailingSlashes = new RegExp('/*$');

  if (customApiEndpoint) {
    apiEndpoint = customApiEndpoint;
    this.customEndpoint = true;
  } else if (process.env.DATASTORE_HOST) {
    apiEndpoint = process.env.DATASTORE_HOST;
    this.customEndpoint = true;
  } else {
    apiEndpoint = 'https://www.googleapis.com';
  }

  if (apiEndpoint.indexOf('http') !== 0) {
    apiEndpoint = 'http://' + apiEndpoint;
  }

  this.apiEndpoint = apiEndpoint.replace(trailingSlashes, '');
};

/**
 * Helper to create a Key object, scoped to the dataset's namespace by default.
 *
 * You may also specify a configuration object to define a namespace and path.
 *
 * @param {...*=} options - Key path. To specify or override a namespace,
 *     you must use an object here to explicitly state it.
 * @param {object=} options - Configuration object.
 * @param {...*=} options.path - Key path.
 * @param {string=} options.namespace - Optional namespace.
 * @return {Key} A newly created Key from the options given.
 *
 * @example
 * var key;
 *
 * // Create an incomplete key from the dataset namespace, kind='Company'
 * key = dataset.key('Company');
 *
 * // A complete key from the dataset namespace, kind='Company', id=123
 * key = dataset.key(['Company', 123]);
 *
 * // A complete key from the dataset namespace, kind='Company', name='Google'
 * // Note: `id` is used for numeric identifiers and `name` is used otherwise
 * key = dataset.key(['Company', 'Google']);
 *
 * // A complete key from a provided namespace and path.
 * key = dataset.key({
 *   namespace: 'My-NS',
 *   path: ['Company', 123]
 * });
 */
Dataset.prototype.key = function(options) {
  options = is.object(options) ? options : {
    namespace: this.namespace,
    path: arrify(options)
  };

  return new entity.Key(options);
};

/**
 * Create a query from the current dataset to query the specified kind, scoped
 * to the namespace provided at the initialization of the dataset.
 *
 * @resource [Datastore Queries]{@link http://goo.gl/Cag0r6}
 *
 * @borrows {module:datastore/query} as createQuery
 * @see {module:datastore/query}
 *
 * @param {string=} namespace - Optional namespace.
 * @param {string} kind - Kind to query.
 * @return {module:datastore/query}
 */
Dataset.prototype.createQuery = function(namespace, kind) {
  if (arguments.length === 1) {
    kind = arrify(namespace);
    namespace = this.namespace;
  }

  return new Query(namespace, arrify(kind));
};

/**
 * Run a function in the context of a new transaction. Transactions allow you to
 * perform multiple operations, committing your changes atomically. When you are
 * finished making your changes within the transaction, run the done() function
 * provided in the callback function to commit your changes. See an example
 * below for more information.
 *
 * @resource [Datasets: beginTransaction API Documentation]{@link https://cloud.google.com/datastore/docs/apis/v1beta2/datasets/beginTransaction}
 *
 * @borrows {module:datastore/transaction#begin} as runInTransaction
 *
 * @param {function} fn - The function to run in the context of a transaction.
 * @param {module:datastore/transaction} fn.transaction - The Transaction.
 * @param {function} fn.done - Function used to commit changes.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 *
 *
 * @example
 * dataset.runInTransaction(function(transaction, done) {
 *   // From the `transaction` object, execute dataset methods as usual.
 *   // Call `done` when you're ready to commit all of the changes.
 *   transaction.get(dataset.key(['Company', 123]), function(err, entity) {
 *     if (err) {
 *       transaction.rollback(done);
 *       return;
 *     }
 *
 *     done();
 *   });
 * }, function(err, apiResponse) {});
 */
Dataset.prototype.runInTransaction = function(fn, callback) {
  var newTransaction = this.createTransaction_();

  newTransaction.begin_(function(err, resp) {
    if (err) {
      callback(err, resp);
      return;
    }

    fn(newTransaction, newTransaction.commit_.bind(newTransaction, callback));
  });
};

/**
 * Create a new Transaction object using the existing connection and dataset.
 *
 * @return {module:datastore/transaction}
 * @private
 */
Dataset.prototype.createTransaction_ = function() {
  return new Transaction(this, this.projectId);
};

module.exports = Dataset;
