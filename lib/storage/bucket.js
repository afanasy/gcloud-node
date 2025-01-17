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
 * @module storage/bucket
 */

'use strict';

var arrify = require('arrify');
var async = require('async');
var extend = require('extend');
var fs = require('fs');
var is = require('is');
var mime = require('mime-types');
var nodeutil = require('util');
var path = require('path');

/**
 * @type {module:storage/acl}
 * @private
 */
var Acl = require('./acl.js');

/**
 * @type {module:storage/file}
 * @private
 */
var File = require('./file.js');

/**
 * @type {module:common/serviceObject}
 * @private
 */
var ServiceObject = require('../common/service-object.js');

/**
 * @type {module:common/streamrouter}
 * @private
 */
var streamRouter = require('../common/stream-router.js');

/**
 * @type {module:common/util}
 * @private
 */
var util = require('../common/util.js');

/**
 * The size of a file (in bytes) must be greater than this number to
 * automatically trigger a resumable upload.
 *
 * @const {number}
 * @private
 */
var RESUMABLE_THRESHOLD = 5000000;

/**
 * Create a Bucket object to interact with a Google Cloud Storage bucket.
 *
 * @constructor
 * @alias module:storage/bucket
 *
 * @throws {Error} if a bucket name isn't provided.
 *
 * @param {object} options - Configuration options.
 * @param {string} options.bucketName - Name of the bucket.
 * @param {string=} options.keyFilename - Full path to the JSON key downloaded
 *     from the Google Developers Console. Alternatively, you may provide a
 *     `credentials` object.
 * @param {object=} options.credentials - Credentials object, used in place of
 *     a `keyFilename`.
 *
 * @example
 * var gcloud = require('gcloud');
 *
 * var gcs = gcloud.storage({
 *   keyFilename: '/path/to/keyfile.json',
 *   projectId: 'grape-spaceship-123'
 * });
 *
 * var bucket = gcs.bucket('albums');
 */

function Bucket(storage, name) {
  var methods = {
    /**
     * Create a bucket.
     *
     * @param {object=} config - See {module:storage#createBucket}.
     *
     * @example
     * bucket.create(function(err, zone, apiResponse) {
     *   if (!err) {
     *     // The zone was created successfully.
     *   }
     * });
     */
    create: true,

    /**
     * Delete the bucket.
     *
     * @resource [Buckets: delete API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/buckets/delete}
     *
     * @param {function=} callback - The callback function.
     * @param {?error} callback.err - An error returned while making this
     *     request.
     * @param {object} callback.apiResponse - The full API response.
     *
     * @example
     * bucket.delete(function(err, apiResponse) {});
     */
    delete: true,

    /**
     * Check if the bucket exists.
     *
     * @param {function} callback - The callback function.
     * @param {?error} callback.err - An error returned while making this
     *     request.
     * @param {boolean} callback.exists - Whether the bucket exists or not.
     *
     * @example
     * bucket.exists(function(err, exists) {});
     */
    exists: true,

    /**
     * Get a bucket if it exists.
     *
     * You may optionally use this to "get or create" an object by providing an
     * object with `autoCreate` set to `true`. Any extra configuration that is
     * normally required for the `create` method must be contained within this
     * object as well.
     *
     * @param {options=} options - Configuration object.
     * @param {boolean} options.autoCreate - Automatically create the object if
     *     it does not exist. Default: `false`
     *
     * @example
     * bucket.get(function(err, bucket, apiResponse) {
     *   // `bucket.metadata` has been populated.
     * });
     */
    get: true,

    /**
     * Get the bucket's metadata.
     *
     * To set metadata, see {module:storage/bucket#setMetadata}.
     *
     * @resource [Buckets: get API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/buckets/get}
     *
     * @param {function=} callback - The callback function.
     * @param {?error} callback.err - An error returned while making this
     *     request.
     * @param {object} callback.metadata - Tbe bucket's metadata.
     * @param {object} callback.apiResponse - The full API response.
     *
     * @example
     * bucket.getMetadata(function(err, metadata, apiResponse) {});
     */
    getMetadata: true,

    /**
     * Set the bucket's metadata.
     *
     * @resource [Buckets: patch API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/buckets/patch}
     *
     * @param {object} metadata - The metadata you wish to set.
     * @param {function=} callback - The callback function.
     * @param {?error} callback.err - An error returned while making this
     *     request.
     * @param {object} callback.apiResponse - The full API response.
     *
     * @example
     * //-
     * // Set website metadata field on the bucket.
     * //-
     * bucket.setMetadata({
     *   website: {
     *     mainPageSuffix: 'http://example.com',
     *     notFoundPage: 'http://example.com/404.html'
     *   }
     * }, function(err, apiResponse) {});
     *
     * //-
     * // Enable versioning for your bucket.
     * //-
     * bucket.setMetadata({
     *   versioning: {
     *     enabled: true
     *   }
     * }, function(err, apiResponse) {});
     */
    setMetadata: true
  };

  ServiceObject.call(this, {
    parent: storage,
    baseUrl: '/b',
    id: name,
    createMethod: storage.createBucket.bind(storage),
    methods: methods
  });

  this.name = name;
  this.storage = storage;

  /**
   * Google Cloud Storage uses access control lists (ACLs) to manage object and
   * bucket access. ACLs are the mechanism you use to share objects with other
   * users and allow other users to access your buckets and objects.
   *
   * An ACL consists of one or more entries, where each entry grants permissions
   * to an entity. Permissions define the actions that can be performed against
   * an object or bucket (for example, `READ` or `WRITE`); the entity defines
   * who the permission applies to (for example, a specific user or group of
   * users).
   *
   * The `acl` object on a Bucket instance provides methods to get you a list of
   * the ACLs defined on your bucket, as well as set, update, and delete them.
   *
   * Buckets also have
   * [default ACLs](https://cloud.google.com/storage/docs/accesscontrol#default)
   * for all created files. Default ACLs specify permissions that all new
   * objects added to the bucket will inherit by default. You can add, delete,
   * get, and update entities and permissions for these as well with
   * {module:storage/bucket#acl.default}.
   *
   * @resource [About Access Control Lists]{@link http://goo.gl/6qBBPO}
   * @resource [Default ACLs]{@link https://cloud.google.com/storage/docs/accesscontrol#default}
   *
   * @mixes module:storage/acl
   *
   * @example
   * //-
   * // Make a bucket's contents publicly readable.
   * //-
   * var myBucket = gcs.bucket('my-bucket');
   * myBucket.acl.add({
   *   entity: 'allUsers',
   *   role: gcs.acl.READER_ROLE
   * }, function(err, aclObject) {});
   */
  this.acl = new Acl({
    request: this.request.bind(this),
    pathPrefix: '/acl'
  });

  this.acl.default = new Acl({
    request: this.request.bind(this),
    pathPrefix: '/defaultObjectAcl'
  });

  /* jshint ignore:start */
  /*! Developer Documentation
   *
   * Sadly, to generate the documentation properly, this comment block describes
   * a useless variable named `ignored` and aliases it to `acl.default`. This is
   * done so the doc building process picks this up, without adding cruft to the
   * Bucket class itself.
   */
  /**
   * Google Cloud Storage Buckets have [default ACLs](http://goo.gl/YpGdyv) for
   * all created files. You can add, delete, get, and update entities and
   * permissions for these as well. The method signatures and examples are all
   * the same, after only prefixing the method call with `default`.
   *
   * @alias acl.default
   */
  var aclDefault = true;

  /**
   * Maps to {module:storage/bucket#acl.add}.
   * @alias acl.default.add
   */
  var aclDefaultAdd = true;

  /**
   * Maps to {module:storage/bucket#acl.delete}.
   * @alias acl.default.delete
   */
  var aclDefaultDelete = true;

  /**
   * Maps to {module:storage/bucket#acl.get}.
   * @alias acl.default.get
   */
  var aclDefaultGet = true;

  /**
   * Maps to {module:storage/bucket#acl.update}.
   * @alias acl.default.update
   */
  var aclDefaultUpdate = true;

  /**
   * Maps to {module:storage/bucket#acl.owners}.
   * @alias acl.default.owners
   */
  var aclDefaultOwners = true;

  /**
   * Maps to {module:storage/bucket#acl.readers}.
   * @alias acl.default.readers
   */
  var aclDefaultReaders = true;

  /**
   * Maps to {module:storage/bucket#acl.writers}.
   * @alias acl.default.writers
   */
  var aclDefaultWriters = true;
  /* jshint ignore:end */
}

nodeutil.inherits(Bucket, ServiceObject);

/**
 * Combine mutliple files into one new file.
 *
 * @resource [Objects: compose API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/compose}
 *
 * @throws {Error} if a non-array is provided as sources argument.
 * @throws {Error} if less than two sources are provided.
 * @throws {Error} if no destination is provided.
 * @throws {Error} if content type can't be determined for the destination file.
 *
 * @param {string[]|module:storage/file} sources - The source files that will be
 *     combined.
 * @param {string|module:storage/file} destination - The file you would like the
 *     source files combined into.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {module:storage/file} callback.newFile - The combined file.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * var logBucket = gcs.bucket('log-bucket');
 *
 * var logs2013 = logBucket.file('2013-logs.txt');
 * var logs2014 = logBucket.file('2014-logs.txt');
 *
 * var allLogs = logBucket.file('all-logs.txt');
 *
 * logBucket.combine([
 *   logs2013,
 *   logs2014
 * ], allLogs, function(err, newFile, apiResponse) {
 *   // newFile === allLogs
 * });
 */
Bucket.prototype.combine = function(sources, destination, callback) {
  if (!is.array(sources) || sources.length < 2) {
    throw new Error('You must provide at least two source files.');
  }

  if (!destination) {
    throw new Error('A destination file must be specified.');
  }

  var self = this;

  sources = sources.map(convertToFile);
  destination = convertToFile(destination);
  callback = callback || util.noop;

  if (!destination.metadata.contentType) {
    var destinationContentType = mime.contentType(destination.name);

    if (destinationContentType) {
      destination.metadata.contentType = destinationContentType;
    } else {
      throw new Error(
        'A content type could not be detected for the destination file.');
    }
  }

  // Make the request from the destination File object.
  destination.request({
    method: 'POST',
    uri: '/compose',
    json: {
      destination: {
        contentType: destination.metadata.contentType
      },
      sourceObjects: sources.map(function(source) {
        var sourceObject = {
          name: source.name
        };

        if (source.metadata && source.metadata.generation) {
          sourceObject.generation = source.metadata.generation;
        }

        return sourceObject;
      })
    }
  }, function(err, resp) {
    if (err) {
      callback(err, null, resp);
      return;
    }

    callback(null, destination, resp);
  });

  function convertToFile(file) {
    if (file instanceof File) {
      return file;
    } else {
      return self.file(file);
    }
  }
};

/**
 * Iterate over the bucket's files, calling `file.delete()` on each.
 *
 * <strong>This is not an atomic request.</strong> A delete attempt will be made
 * for each file individually. Any one can fail, in which case only a portion of
 * the files you intended to be deleted would have.
 *
 * Operations are performed in parallel, up to 10 at once. The first error
 * breaks the loop and will execute the provided callback with it. Specify
 * `{ force: true }` to suppress the errors until all files have had a chance to
 * be processed.
 *
 * The `query` object passed as the first argument will also be passed to
 * {module:storage/bucket#getFiles}.
 *
 * @resource [Objects: delete API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/delete}
 *
 * @param {object=} query - Query object. See {module:storage/bucket#getFiles}
 *     for all of the supported properties.
 * @param {boolean} query.force - Supress errors until all files have been
 *     processed.
 * @param {function} callback - The callback function.
 * @param {?error|?error[]} callback.err - An API error or array of errors from
 *     files that were not able to be deleted.
 *
 * @example
 * //-
 * // Delete all of the files in the bucket.
 * //-
 * bucket.deleteFiles(function(err) {});
 *
 * //-
 * // By default, if a file cannot be deleted, this method will stop deleting
 * // files from your bucket. You can override this setting with `force: true`.
 * //-
 * bucket.deleteFiles({
 *   force: true
 * }, function(errors) {
 *   // `errors`:
 *   //    Array of errors if any occurred, otherwise null.
 * });
 *
 * //-
 * // The first argument to this method acts as a query to
 * // {module:storage/bucket#getFiles}. As an example, you can delete files
 * // which match a prefix.
 * //-
 * bucket.deleteFiles({
 *   prefix: 'images/'
 * }, function(err) {
 *   if (!err) {
 *     // All files in the `images` directory have been deleted.
 *   }
 * });
 */
Bucket.prototype.deleteFiles = function(query, callback) {
  if (is.fn(query)) {
    callback = query;
    query = {};
  }

  query = query || {};

  var MAX_PARALLEL_LIMIT = 10;
  var errors = [];

  this.getFiles(query, function(err, files) {
    if (err) {
      callback(err);
      return;
    }

    function deleteFile(file, callback) {
      file.delete(function(err) {
        if (err) {
          if (query.force) {
            errors.push(err);
            callback();
            return;
          }

          callback(err);
          return;
        }

        callback();
      });
    }

    // Iterate through each file and attempt to delete it.
    async.eachLimit(files, MAX_PARALLEL_LIMIT, deleteFile, function(err) {
      if (err || errors.length > 0) {
        callback(err || errors);
        return;
      }

      callback();
    });
  });

};

/**
 * Create a File object. See {module:storage/file} to see how to handle
 * the different use cases you may have.
 *
 * @param {string} name - The name of the file in this bucket.
 * @param {object=} options - Configuration options.
 * @param {string|number} options.generation - Only use a specific revision of
 *     this file.
 * @return {module:storage/file}
 *
 * @example
 * var file = bucket.file('my-existing-file.png');
 */
Bucket.prototype.file = function(name, options) {
  if (!name) {
    throw Error('A file name must be specified.');
  }

  return new File(this, name, options);
};

/**
 * Get File objects for the files currently in the bucket.
 *
 * @resource [Objects: list API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/list}
 *
 * @param {object=} query - Query object.
 * @param {boolean} query.autoPaginate - Have pagination handled automatically.
 *     Default: true.
 * @param {string} query.delimiter - Results will contain only objects whose
 *     names, aside from the prefix, do not contain delimiter. Objects whose
 *     names, aside from the prefix, contain delimiter will have their name
 *     truncated after the delimiter, returned in `apiResponse.prefixes`.
 *     Duplicate prefixes are omitted.
 * @param {string} query.prefix - Filter results to objects whose names begin
 *     with this prefix.
 * @param {number} query.maxResults - Maximum number of items plus prefixes to
 *     return.
 * @param {string} query.pageToken - A previously-returned page token
 *     representing part of the larger set of results to view.
 * @param {bool} query.versions - If true, returns File objects scoped to their
 *     versions.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {module:storage/file[]} callback.files - List of files.
 * @param {?object} callback.nextQuery - If present, query with this object to
 *     check for more results.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * bucket.getFiles(function(err, files) {
 *   if (!err) {
 *     // files is an array of File objects.
 *   }
 * });
 *
 * //-
 * // If your bucket has versioning enabled, you can get all of your files
 * // scoped to their generation.
 * //-
 * bucket.getFiles({
 *   versions: true
 * }, function(err, files) {
 *   // Each file is scoped to its generation.
 * });
 *
 * //-
 * // To control how many API requests are made and page through the results
 * // manually, set `autoPaginate` to `false`.
 * //-
 * var callback = function(err, files, nextQuery, apiResponse) {
 *   if (nextQuery) {
 *     // More results exist.
 *     bucket.getFiles(nextQuery, callback);
 *   }
 *
 *   // The `metadata` property is populated for you with the metadata at the
 *   // time of fetching.
 *   files[0].metadata;
 *
 *   // However, in cases where you are concerned the metadata could have
 *   // changed, use the `getMetadata` method.
 *   files[0].getMetadata(function(err, metadata) {});
 * };
 *
 * bucket.getFiles({
 *   autoPaginate: false
 * }, callback);
 *
 * //-
 * // Get the files from your bucket as a readable object stream.
 * //-
 * bucket.getFiles()
 *   .on('error', console.error)
 *   .on('data', function(file) {
 *     // file is a File object.
 *   })
 *   .on('end', function() {
 *     // All files retrieved.
 *   });
 *
 * //-
 * // If you anticipate many results, you can end a stream early to prevent
 * // unnecessary processing and API requests.
 * //-
 * bucket.getFiles()
 *   .on('data', function(file) {
 *     this.end();
 *   });
 */
Bucket.prototype.getFiles = function(query, callback) {
  var self = this;

  if (!callback) {
    callback = query;
    query = {};
  }

  this.request({
    uri: '/o',
    qs: query
  }, function(err, resp) {
    if (err) {
      callback(err, null, null, resp);
      return;
    }

    var files = arrify(resp.items).map(function(file) {
      var options = {};

      if (query.versions) {
        options.generation = file.generation;
      }

      var fileInstance = self.file(file.name, options);
      fileInstance.metadata = file;

      return fileInstance;
    });

    var nextQuery = null;
    if (resp.nextPageToken) {
      nextQuery = extend({}, query, {
        pageToken: resp.nextPageToken
      });
    }

    callback(null, files, nextQuery, resp);
  });
};

/**
 * Make the bucket listing private.
 *
 * You may also choose to make the contents of the bucket private by specifying
 * `includeFiles: true`. This will automatically run
 * {module:storage/file#makePrivate} for every file in the bucket.
 *
 * When specifying `includeFiles: true`, use `force: true` to delay execution of
 * your callback until all files have been processed. By default, the callback
 * is executed after the first error. Use `force` to queue such errors until all
 * files have been procssed, after which they will be returned as an array as
 * the first argument to your callback.
 *
 * NOTE: This may cause the process to be long-running and use a high number of
 * requests. Use with caution.
 *
 * @resource [Buckets: patch API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/buckets/patch}
 *
 * @param {object=} options - The configuration object.
 * @param {boolean} options.includeFiles - Make each file in the bucket private.
 *     Default: `false`.
 * @param {boolean} options.force - Queue errors occurred while making files
 *     private until all files have been processed.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {module:storage/file[]} callback.files - List of files made private.
 *
 * @example
 * //-
 * // Make the bucket private.
 * //-
 * bucket.makePrivate(function(err) {});
 *
 * //-
 * // Make the bucket and its contents private.
 * //-
 * var opts = {
 *   includeFiles: true
 * };
 *
 * bucket.makePrivate(opts, function(err, files) {
 *   // `err`:
 *   //    The first error to occur, otherwise null.
 *   //
 *   // `files`:
 *   //    Array of files successfully made private in the bucket.
 * });
 *
 * //-
 * // Make the bucket and its contents private, using force to suppress errors
 * // until all files have been processed.
 * //-
 * var opts = {
 *   includeFiles: true,
 *   force: true
 * };
 *
 * bucket.makePrivate(opts, function(errors, files) {
 *   // `errors`:
 *   //    Array of errors if any occurred, otherwise null.
 *   //
 *   // `files`:
 *   //    Array of files successfully made private in the bucket.
 * });
 */
Bucket.prototype.makePrivate = function(options, callback) {
  var self = this;

  if (is.fn(options)) {
    callback = options;
    options = {};
  }

  options = options || {};
  options.private = true;

  async.series([setPredefinedAcl, makeFilesPrivate], callback);

  function setPredefinedAcl(done) {
    var query = {
      predefinedAcl: 'projectPrivate'
    };

    // You aren't allowed to set both predefinedAcl & acl properties on a bucket
    // so acl must explicitly be nullified.
    var metadata = {
      acl: null
    };

    self.request({
      method: 'PATCH',
      uri: '',
      qs: query,
      json: metadata
    }, function(err, resp) {
      if (err) {
        done(err);
        return;
      }

      self.metadata = resp;

      done();
    });
  }

  function makeFilesPrivate(done) {
    if (!options.includeFiles) {
      done();
      return;
    }

    self.makeAllFilesPublicPrivate_(options, done);
  }
};

/**
 * Make the bucket publicly readable.
 *
 * You may also choose to make the contents of the bucket publicly readable by
 * specifying `includeFiles: true`. This will automatically run
 * {module:storage/file#makePublic} for every file in the bucket.
 *
 * When specifying `includeFiles: true`, use `force: true` to delay execution of
 * your callback until all files have been processed. By default, the callback
 * is executed after the first error. Use `force` to queue such errors until all
 * files have been procssed, after which they will be returned as an array as
 * the first argument to your callback.
 *
 * NOTE: This may cause the process to be long-running and use a high number of
 * requests. Use with caution.
 *
 * @resource [Buckets: patch API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/buckets/patch}
 *
 * @param {object=} options - The configuration object.
 * @param {boolean} options.includeFiles - Make each file in the bucket publicly
 *     readable. Default: `false`.
 * @param {boolean} options.force - Queue errors occurred while making files
 *     public until all files have been processed.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {module:storage/file[]} callback.files - List of files made public.
 *
 * @example
 * //-
 * // Make the bucket publicly readable.
 * //-
 * bucket.makePublic(function(err) {});
 *
 * //-
 * // Make the bucket and its contents publicly readable.
 * //-
 * var opts = {
 *   includeFiles: true
 * };
 *
 * bucket.makePublic(opts, function(err, files) {
 *   // `err`:
 *   //    The first error to occur, otherwise null.
 *   //
 *   // `files`:
 *   //    Array of files successfully made public in the bucket.
 * });
 *
 * //-
 * // Make the bucket and its contents publicly readable, using force to
 * // suppress errors until all files have been processed.
 * //-
 * var opts = {
 *   includeFiles: true,
 *   force: true
 * };
 *
 * bucket.makePublic(opts, function(errors, files) {
 *   // `errors`:
 *   //    Array of errors if any occurred, otherwise null.
 *   //
 *   // `files`:
 *   //    Array of files successfully made public in the bucket.
 * });
 */
Bucket.prototype.makePublic = function(options, callback) {
  var self = this;

  if (is.fn(options)) {
    callback = options;
    options = {};
  }

  options = options || {};
  options.public = true;

  async.series([
    addAclPermissions,
    addDefaultAclPermissions,
    makeFilesPublic
  ], callback);

  function addAclPermissions(done) {
    // Allow reading bucket contents while preserving original permissions.
    self.acl.add({
      entity: 'allUsers',
      role: 'READER'
    }, done);
  }

  function addDefaultAclPermissions(done) {
    self.acl.default.add({
      entity: 'allUsers',
      role: 'READER'
    }, done);
  }

  function makeFilesPublic(done) {
    if (!options.includeFiles) {
      done();
      return;
    }

    self.makeAllFilesPublicPrivate_(options, done);
  }
};

/**
 * Upload a file to the bucket. This is a convenience method that wraps
 * {module:storage/file#createWriteStream}.
 *
 * You can specify whether or not an upload is resumable by setting
 * `options.resumable`. *Resumable uploads are enabled by default if your input
 * file is larger than 5 MB.*
 *
 * @resource [Upload Options (Simple or Resumable)]{@link https://cloud.google.com/storage/docs/json_api/v1/how-tos/upload#uploads}
 * @resource [Objects: insert API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/insert}
 *
 * @param {string} localPath - The fully qualified path to the file you wish to
 *     upload to your bucket.
 * @param {object=} options - Configuration options.
 * @param {string|module:storage/file} options.destination - The place to save
 *     your file. If given a string, the file will be uploaded to the bucket
 *     using the string as a filename. When given a File object, your local file
 *     will be uploaded to the File object's bucket and under the File object's
 *     name. Lastly, when this argument is omitted, the file is uploaded to your
 *     bucket using the name of the local file.
 * @param {boolean} options.gzip - Automatically gzip the file. This will set
 *     `options.metadata.contentEncoding` to `gzip`.
 * @param {object=} options.metadata - Metadata to set for your file.
 * @param {boolean=} options.resumable - Force a resumable upload. (default:
 *     true for files larger than 5 MB).
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {module:storage/file} callback.file - The uploaded File.
 * @param {object} callback.apiResponse - The full API response.
 * @param {string|boolean} options.validation - Possible values: `"md5"`,
 *     `"crc32c"`, or `false`. By default, data integrity is validated with an
 *     MD5 checksum for maximum reliability. CRC32c will provide better
 *     performance with less reliability. You may also choose to skip validation
 *     completely, however this is **not recommended**.
 *
 * @example
 * //-
 * // The easiest way to upload a file.
 * //-
 * bucket.upload('/local/path/image.png', function(err, file, apiResponse) {
 *   // Your bucket now contains:
 *   // - "image.png" (with the contents of `/local/path/image.png')
 *
 *   // `file` is an instance of a File object that refers to your new file.
 * });
 *
 * //-
 * // It's not always that easy. You will likely want to specify the filename
 * // used when your new file lands in your bucket.
 * //
 * // You may also want to set metadata or customize other options.
 * //-
 * var options = {
 *   destination: 'new-image.png',
 *   resumable: true,
 *   validation: 'crc32c',
 *   metadata: {
 *     event: 'Fall trip to the zoo'
 *   }
 * };
 *
 * bucket.upload('local-image.png', options, function(err, file) {
 *   // Your bucket now contains:
 *   // - "new-image.png" (with the contents of `local-image.png')
 *
 *   // `file` is an instance of a File object that refers to your new file.
 * });
 *
 * //-
 * // You can also have a file gzip'd on the fly.
 * //-
 * bucket.upload('index.html', { gzip: true }, function(err, file) {
 *   // Your bucket now contains:
 *   // - "index.html" (automatically compressed with gzip)
 *
 *   // Downloading the file with `file.download` will automatically decode the
 *   // file.
 * });
 *
 * //-
 * // You may also re-use a File object, {module:storage/file}, that references
 * // the file you wish to create or overwrite.
 * //-
 * var options = {
 *   destination: bucket.file('existing-file.png'),
 *   resumable: false
 * };
 *
 * bucket.upload('local-img.png', options, function(err, newFile) {
 *   // Your bucket now contains:
 *   // - "existing-file.png" (with the contents of `local-img.png')
 *
 *   // Note:
 *   // The `newFile` parameter is equal to `file`.
 * });
 */
Bucket.prototype.upload = function(localPath, options, callback) {
  if (is.fn(options)) {
    callback = options;
    options = {};
  }

  var newFile;
  if (options.destination instanceof File) {
    newFile = options.destination;
  } else if (is.string(options.destination)) {
    // Use the string as the name of the file.
    newFile = this.file(options.destination);
  } else {
    // Resort to using the name of the incoming file.
    newFile = this.file(path.basename(localPath));
  }

  var metadata = options.metadata || {};
  var contentType = mime.contentType(path.basename(localPath));

  if (contentType && !metadata.contentType) {
    metadata.contentType = contentType;
  }

  var resumable;
  if (is.boolean(options.resumable)) {
    resumable = options.resumable;
    upload();
  } else {
    // Determine if the upload should be resumable if it's over the threshold.
    fs.stat(localPath, function(err, fd) {
      if (err) {
        callback(err);
        return;
      }

      resumable = fd.size > RESUMABLE_THRESHOLD;

      upload();
    });
  }

  function upload() {
    fs.createReadStream(localPath)
      .pipe(newFile.createWriteStream({
        validation: options.validation,
        resumable: resumable,
        metadata: metadata,
        gzip: options.gzip
      }))
      .on('error', function(err) {
        callback(err);
      })
      .on('finish', function() {
        callback(null, newFile);
      });
  }
};

/**
 * Iterate over all of a bucket's files, calling `file.makePublic()` (public)
 * or `file.makePrivate()` (private) on each.
 *
 * Operations are performed in parallel, up to 10 at once. The first error
 * breaks the loop, and will execute the provided callback with it. Specify
 * `{ force: true }` to suppress the errors.
 *
 * @private
 *
 * @param {object} options - Configuration object.
 * @param {boolean} options.force - Supress errors until all files have been
 *     processed.
 * @param {boolean} options.private - Make files private.
 * @param {boolean} options.public - Make files public.
 * @param {function} callback - The callback function.
 */
Bucket.prototype.makeAllFilesPublicPrivate_ = function(options, callback) {
  var MAX_PARALLEL_LIMIT = 10;
  var errors = [];
  var updatedFiles = [];

  this.getFiles(function(err, files) {
    if (err) {
      callback(err);
      return;
    }

    function processFile(file, callback) {
      if (options.public) {
        file.makePublic(processedCallback);
      } else if (options.private) {
        file.makePrivate(processedCallback);
      }

      function processedCallback(err) {
        if (err) {
          if (options.force) {
            errors.push(err);
            callback();
            return;
          }

          callback(err);
          return;
        }

        updatedFiles.push(file);
        callback();
      }
    }

    // Iterate through each file and make it public or private.
    async.eachLimit(files, MAX_PARALLEL_LIMIT, processFile, function(err) {
      if (err || errors.length > 0) {
        callback(err || errors, updatedFiles);
        return;
      }

      callback(null, updatedFiles);
    });
  });
};

/*! Developer Documentation
 *
 * This method can be used with either a callback or as a readable object
 * stream. `streamRouter` is used to add this dual behavior.
 */
streamRouter.extend(Bucket, 'getFiles');

module.exports = Bucket;
