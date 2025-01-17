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
 * @module storage/file
 */

'use strict';

var concat = require('concat-stream');
var createErrorClass = require('create-error-class');
var crypto = require('crypto');
var duplexify = require('duplexify');
var format = require('string-format-obj');
var fs = require('fs');
var hashStreamValidation = require('hash-stream-validation');
var is = require('is');
var nodeutil = require('util');
var once = require('once');
var pumpify = require('pumpify');
var resumableUpload = require('gcs-resumable-upload');
var streamEvents = require('stream-events');
var through = require('through2');
var zlib = require('zlib');

/**
 * @type {module:storage/acl}
 * @private
 */
var Acl = require('./acl.js');

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

/**
 * Custom error type for errors related to getting signed errors and policies.
 *
 * @param {string} message - Custom error message.
 * @return {Error}
 */
var SigningError = createErrorClass('SigningError', function(message) {
  this.message = message;
});

/**
 * @const {string}
 * @private
 */
var STORAGE_DOWNLOAD_BASE_URL = 'https://storage.googleapis.com';

/**
 * @const {string}
 * @private
 */
var STORAGE_UPLOAD_BASE_URL = 'https://www.googleapis.com/upload/storage/v1/b';

/*! Developer Documentation
 *
 * @param {module:storage/bucket} bucket - The Bucket instance this file is
 *     attached to.
 * @param {string} name - The name of the remote file.
 * @param {object=} options - Configuration object.
 * @param {number} options.generation - Generation to scope the file to.
 */
/**
 * A File object is created from your Bucket object using
 * {module:storage/bucket#file}.
 *
 * @alias module:storage/file
 * @constructor
 *
 * @example
 * var gcloud = require('gcloud');
 *
 * var gcs = gcloud.storage({
 *   keyFilename: '/path/to/keyfile.json',
 *   projectId: 'grape-spaceship-123'
 * });
 *
 * var myBucket = gcs.bucket('my-bucket');
 *
 * var file = myBucket.file('my-file');
 */
function File(bucket, name, options) {
  options = options || {};

  this.bucket = bucket;
  this.storage = bucket.parent;

  Object.defineProperty(this, 'name', {
    enumerable: true,
    value: name
  });

  var generation = parseInt(options.generation, 10);
  var requestQueryObject = {};

  if (!isNaN(generation)) {
    requestQueryObject.generation = generation;
    this.generation = generation;
  }

  var methods = {
    /**
     * Delete the file.
     *
     * @resource [Objects: delete API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/delete}
     *
     * @param {function=} callback - The callback function.
     * @param {?error} callback.err - An error returned while making this
     *     request.
     * @param {object} callback.apiResponse - The full API response.
     *
     * @example
     * file.delete(function(err, apiResponse) {});
     */
    delete: {
      reqOpts: {
        qs: requestQueryObject
      }
    },

    /**
     * Check if the file exists.
     *
     * @param {function} callback - The callback function.
     * @param {?error} callback.err - An error returned while making this
     *     request.
     * @param {boolean} callback.exists - Whether the file exists or not.
     *
     * @example
     * file.exists(function(err, exists) {});
     */
    exists: true,

    /**
     * Get a file object and its metadata if it exists.
     *
     * @example
     * file.get(function(err, file, apiResponse) {
     *   // file.metadata` has been populated.
     * });
     */
    get: true,

    /**
     * Get the file's metadata.
     *
     * @resource [Objects: get API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/get}
     *
     * @param {function=} callback - The callback function.
     * @param {?error} callback.err - An error returned while making this
     *     request.
     * @param {object} callback.metadata - The File's metadata.
     * @param {object} callback.apiResponse - The full API response.
     *
     * @example
     * file.getMetadata(function(err, metadata, apiResponse) {});
     */
    getMetadata: {
      reqOpts: {
        qs: requestQueryObject
      }
    },

    /**
     * Merge the given metadata with the current remote file's metadata. This
     * will set metadata if it was previously unset or update previously set
     * metadata. To unset previously set metadata, set its value to null.
     *
     * You can set custom key/value pairs in the metadata key of the given
     * object, however the other properties outside of this object must adhere
     * to the [official API documentation](https://goo.gl/BOnnCK).
     *
     * See the examples below for more information.
     *
     * @resource [Objects: patch API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/patch}
     *
     * @param {object} metadata - The metadata you wish to update.
     * @param {function=} callback - The callback function.
     * @param {?error} callback.err - An error returned while making this
     *     request.
     * @param {object} callback.apiResponse - The full API response.
     *
     * @example
     * file.setMetadata({
     *   contentType: 'application/x-font-ttf',
     *   metadata: {
     *     my: 'custom',
     *     properties: 'go here'
     *   }
     * }, function(err, apiResponse) {});
     *
     * // Assuming current metadata = { hello: 'world', unsetMe: 'will do' }
     * file.setMetadata({
     *   metadata: {
     *     abc: '123', // will be set.
     *     unsetMe: null, // will be unset (deleted).
     *     hello: 'goodbye' // will be updated from 'hello' to 'goodbye'.
     *   }
     * }, function(err, apiResponse) {
     *   // metadata should now be { abc: '123', hello: 'goodbye' }
     * });
     */
    setMetadata: {
      reqOpts: {
        qs: requestQueryObject
      }
    }
  };

  ServiceObject.call(this, {
    parent: bucket,
    baseUrl: '/o',
    id: encodeURIComponent(name),
    methods: methods
  });

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
   * The `acl` object on a File instance provides methods to get you a list of
   * the ACLs defined on your bucket, as well as set, update, and delete them.
   *
   * @resource [About Access Control lists]{@link http://goo.gl/6qBBPO}
   *
   * @mixes module:storage/acl
   *
   * @example
   * //-
   * // Make a file publicly readable.
   * //-
   * file.acl.add({
   *   entity: 'allUsers',
   *   role: gcs.acl.READER_ROLE
   * }, function(err, aclObject) {});
   */
  this.acl = new Acl({
    request: this.request.bind(this),
    pathPrefix: '/acl'
  });
}

nodeutil.inherits(File, ServiceObject);

/**
 * Copy this file to another file. By default, this will copy the file to the
 * same bucket, but you can choose to copy it to another Bucket by providing
 * either a Bucket or File object.
 *
 * @resource [Objects: copy API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/copy}
 *
 * @throws {Error} If the destination file is not provided.
 *
 * @param {string|module:storage/bucket|module:storage/file} destination -
 *     Destination file.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {module:storage/file} callback.copiedFile - The copied File.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * //-
 * // You can pass in a variety of types for the destination.
 * //
 * // For all of the below examples, assume we are working with the following
 * // Bucket and File objects.
 * //-
 * var bucket = gcs.bucket('my-bucket');
 * var file = bucket.file('my-image.png');
 *
 * //-
 * // If you pass in a string for the destination, the file is copied to its
 * // current bucket, under the new name provided.
 * //-
 * file.copy('my-image-copy.png', function(err, copiedFile, apiResponse) {
 *   // `my-bucket` now contains:
 *   // - "my-image.png"
 *   // - "my-image-copy.png"
 *
 *   // `copiedFile` is an instance of a File object that refers to your new
 *   // file.
 * });
 *
 * //-
 * // If you pass in a Bucket object, the file will be copied to that bucket
 * // using the same name.
 * //-
 * var anotherBucket = gcs.bucket('another-bucket');
 * file.copy(anotherBucket, function(err, copiedFile, apiResponse) {
 *   // `my-bucket` still contains:
 *   // - "my-image.png"
 *   //
 *   // `another-bucket` now contains:
 *   // - "my-image.png"
 *
 *   // `copiedFile` is an instance of a File object that refers to your new
 *   // file.
 * });
 *
 * //-
 * // If you pass in a File object, you have complete control over the new
 * // bucket and filename.
 * //-
 * var anotherFile = anotherBucket.file('my-awesome-image.png');
 * file.copy(anotherFile, function(err, copiedFile, apiResponse) {
 *   // `my-bucket` still contains:
 *   // - "my-image.png"
 *   //
 *   // `another-bucket` now contains:
 *   // - "my-awesome-image.png"
 *
 *   // Note:
 *   // The `copiedFile` parameter is equal to `anotherFile`.
 * });
 */
File.prototype.copy = function(destination, callback) {
  var noDestinationError = new Error('Destination file should have a name.');

  if (!destination) {
    throw noDestinationError;
  }

  callback = callback || util.noop;

  var destBucket;
  var destName;
  var newFile;

  if (is.string(destination)) {
    destBucket = this.bucket;
    destName = destination;
  } else if (destination.constructor &&
        destination.constructor.name === 'Bucket') {
    destBucket = destination;
    destName = this.name;
  } else if (destination instanceof File) {
    destBucket = destination.bucket;
    destName = destination.name;
    newFile = destination;
  } else {
    throw noDestinationError;
  }

  var query = {};
  if (is.defined(this.generation)) {
    query.sourceGeneration = this.generation;
  }

  newFile = newFile || destBucket.file(destName);

  this.request({
    method: 'POST',
    uri: format('/copyTo/b/{bucketName}/o/{fileName}', {
      bucketName: destBucket.name,
      fileName: encodeURIComponent(destName)
    }),
    qs: query
  }, function(err, resp) {
    if (err) {
      callback(err, null, resp);
      return;
    }

    callback(null, newFile, resp);
  });
};

/**
 * Create a readable stream to read the contents of the remote file. It can be
 * piped to a writable stream or listened to for 'data' events to read a file's
 * contents.
 *
 * In the unlikely event there is a mismatch between what you downloaded and the
 * version in your Bucket, your error handler will receive an error with code
 * "CONTENT_DOWNLOAD_MISMATCH". If you receive this error, the best recourse is
 * to try downloading the file again.
 *
 * NOTE: Readable streams will emit the `end` event when the file is fully
 * downloaded.
 *
 * @param {object=} options - Configuration object.
 * @param {string|boolean} options.validation - Possible values: `"md5"`,
 *     `"crc32c"`, or `false`. By default, data integrity is validated with an
 *     MD5 checksum for maximum reliability, falling back to CRC32c when an MD5
 *     hash wasn't returned from the API. CRC32c will provide better performance
 *     with less reliability. You may also choose to skip validation completely,
 *     however this is **not recommended**.
 * @param {number} options.start - A byte offset to begin the file's download
 *     from. Default is 0. NOTE: Byte ranges are inclusive; that is,
 *     `options.start = 0` and `options.end = 999` represent the first 1000
 *     bytes in a file or object. NOTE: when specifying a byte range, data
 *     integrity is not available.
 * @param {number} options.end - A byte offset to stop reading the file at.
 *     NOTE: Byte ranges are inclusive; that is, `options.start = 0` and
 *     `options.end = 999` represent the first 1000 bytes in a file or object.
 *     NOTE: when specifying a byte range, data integrity is not available.
 *
 * @example
 * //-
 * // <h4>Downloading a File</h4>
 * //
 * // The example below demonstrates how we can reference a remote file, then
 * // pipe its contents to a local file. This is effectively creating a local
 * // backup of your remote data.
 * //-
 * var fs = require('fs');
 * var remoteFile = bucket.file('image.png');
 * var localFilename = '/Users/stephen/Photos/image.png';
 *
 * remoteFile.createReadStream()
 *   .on('error', function(err) {})
 *   .on('response', function(response) {
 *     // Server connected and responded with the specified status and headers.
 *    })
 *   .on('end', function() {
 *     // The file is fully downloaded.
 *   })
 *   .pipe(fs.createWriteStream(localFilename));
 *
 * //-
 * // To limit the downloaded data to only a byte range, pass an options object.
 * //-
 * var logFile = myBucket.file('access_log');
 * logFile.createReadStream({
 *     start: 10000,
 *     end: 20000
 *   })
 *   .on('error', function(err) {})
 *   .pipe(fs.createWriteStream('/Users/stephen/logfile.txt'));
 *
 * //-
 * // To read a tail byte range, specify only `options.end` as a negative
 * // number.
 * //-
 * var logFile = myBucket.file('access_log');
 * logFile.createReadStream({
 *     end: -100
 *   })
 *   .on('error', function(err) {})
 *   .pipe(fs.createWriteStream('/Users/stephen/logfile.txt'));
 */
File.prototype.createReadStream = function(options) {
  options = options || {};

  var self = this;
  var rangeRequest = is.number(options.start) || is.number(options.end);
  var tailRequest = options.end < 0;
  var throughStream = streamEvents(through());

  var crc32c = options.validation !== false;
  var md5 = options.validation !== false;

  if (is.string(options.validation)) {
    options.validation = options.validation.toLowerCase();
    crc32c = options.validation === 'crc32c';
    md5 = options.validation === 'md5';
  }

  if (rangeRequest) {
    if (is.string(options.validation) || options.validation === true) {
      throw new Error('Cannot use validation with file ranges (start/end).');
    }
    // Range requests can't receive data integrity checks.
    crc32c = false;
    md5 = false;
  }

  // Authenticate the request, then pipe the remote API request to the stream
  // returned to the user.
  function makeRequest() {
    var reqOpts = {
      uri: format('{downloadBaseUrl}/{bucketName}/{fileName}', {
        downloadBaseUrl: STORAGE_DOWNLOAD_BASE_URL,
        bucketName: self.bucket.name,
        fileName: encodeURIComponent(self.name)
      }),
      gzip: true
    };

    if (self.generation) {
      reqOpts.qs = {
        generation: self.generation
      };
    }

    if (rangeRequest) {
      var start = is.number(options.start) ? options.start : '0';
      var end = is.number(options.end) ? options.end : '';

      reqOpts.headers = {
        Range: 'bytes=' + (tailRequest ? end : start + '-' + end)
      };
    }

    var requestStream = self.storage.makeAuthenticatedRequest(reqOpts);
    var validateStream;

    // We listen to the response event from the request stream so that we can...
    //
    //   1) Intercept any data from going to the user if an error occurred.
    //   2) Calculate the hashes from the http.IncomingMessage response stream,
    //      which will return the bytes from the source without decompressing
    //      gzip'd content. The request stream will do the decompression so the
    //      user receives the expected content.
    function onResponse(err, body, res) {
      if (err) {
        requestStream.unpipe(throughStream);
        return;
      }

      if (!rangeRequest) {
        validateStream = hashStreamValidation({
          crc32c: crc32c,
          md5: md5
        });

        res.pipe(validateStream).on('data', util.noop);
      }
    }

    // This is hooked to the `complete` event from the request stream. This is
    // our chance to validate the data and let the user know if anything went
    // wrong.
    function onComplete(err, body, res) {
      if (err) {
        throughStream.destroy(err);
        return;
      }

      if (rangeRequest) {
        return;
      }

      var hashes = {};
      res.headers['x-goog-hash'].split(',').forEach(function(hash) {
        var hashType = hash.split('=')[0].trim();
        hashes[hashType] = hash.substr(hash.indexOf('=') + 1);
      });

      // If we're doing validation, assume the worst-- a data integrity
      // mismatch. If not, these tests won't be performed, and we can assume the
      // best.
      var failed = crc32c || md5;

      if (crc32c && hashes.crc32c) {
        // We must remove the first four bytes from the returned checksum.
        // http://stackoverflow.com/questions/25096737/
        //   base64-encoding-of-crc32c-long-value
        failed = !validateStream.test('crc32c', hashes.crc32c.substr(4));
      }

      if (md5 && hashes.md5) {
        failed = !validateStream.test('md5', hashes.md5);
      }

      if (failed) {
        var mismatchError = new Error([
          'The downloaded data did not match the data from the server.',
          'To be sure the content is the same, you should download the',
          'file again.'
        ].join(' '));
        mismatchError.code = 'CONTENT_DOWNLOAD_MISMATCH';

        throughStream.destroy(mismatchError);
      }
    }

    requestStream
      .on('error', function(err) {
        throughStream.destroy(err);
      })
      .on('response', function(res) {
        throughStream.emit('response', res);
        util.handleResp(null, res, null, onResponse);
      })
      .on('complete', function(res) {
        util.handleResp(null, res, null, onComplete);
      })
      .pipe(throughStream)
      .on('error', function() {
        // An error can occur before the request stream has been created (during
        // authentication).
        if (requestStream.abort) {
          requestStream.abort();
        }

        requestStream.destroy();
      });
  }

  throughStream.on('reading', makeRequest);

  return throughStream;
};

/**
 * Create a unique resumable upload session URI. This is the first step when
 * performing a resumable upload.
 *
 * See the [Resumable upload guide](https://cloud.google.com/storage/docs/json_api/v1/how-tos/upload#resumable)
 * for more on how the entire process works.
 *
 * <h4>Note</h4>
 *
 * If you are just looking to perform a resumable upload without worrying about
 * any of the details, see {module:storage/createWriteStream}. Resumable uploads
 * are performed by default.
 *
 * @resource [Resumable upload guide]{@link https://cloud.google.com/storage/docs/json_api/v1/how-tos/upload#resumable}
 *
 * @param {object=} metadata - Optional metadata to set on the file.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {string} callback.uri - The resumable upload's unique session URI.
 *
 * @example
 * file.createResumableUpload(function(err, uri) {
 *   if (!err) {
 *     // `uri` can be used to PUT data to.
 *   }
 * });
 */
File.prototype.createResumableUpload = function(metadata, callback) {
  if (is.fn(metadata)) {
    callback = metadata;
    metadata = {};
  }

  resumableUpload.createURI({
    authClient: this.bucket.storage.authClient,
    bucket: this.bucket.name,
    file: this.name,
    generation: this.generation,
    metadata: metadata || {}
  }, callback);
};

/**
 * Create a writable stream to overwrite the contents of the file in your
 * bucket.
 *
 * A File object can also be used to create files for the first time.
 *
 * Resumable uploads are automatically enabled and must be shut off explicitly
 * by setting `options.resumable` to `false`.
 *
 * NOTE: Writable streams will emit the `finish` event when the file is fully
 * uploaded.
 *
 * @resource [Upload Options (Simple or Resumable)]{@link https://cloud.google.com/storage/docs/json_api/v1/how-tos/upload#uploads}
 * @resource [Objects: insert API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/insert}
 *
 * @param {object=} options - Configuration object.
 * @param {boolean} options.gzip - Automatically gzip the file. This will set
 *     `options.metadata.contentEncoding` to `gzip`.
 * @param {object} options.metadata - Set the metadata for this file.
 * @param {boolean} options.resumable - Force a resumable upload. NOTE: When
 *     working with streams, the file format and size is unknown until it's
 *     completely consumed. Because of this, it's best for you to be explicit
 *     for what makes sense given your input.
 * @param {string|boolean} options.validation - Possible values: `"md5"`,
 *     `"crc32c"`, or `false`. By default, data integrity is validated with an
 *     MD5 checksum for maximum reliability. CRC32c will provide better
 *     performance with less reliability. You may also choose to skip validation
 *     completely, however this is **not recommended**.
 *
 * @example
 * var fs = require('fs');
 *
 * //-
 * // <h4>Uploading a File</h4>
 * //
 * // Now, consider a case where we want to upload a file to your bucket. You
 * // have the option of using {module:storage/bucket#upload}, but that is just
 * // a convenience method which will do the following.
 * //-
 * fs.createReadStream('/Users/stephen/Photos/birthday-at-the-zoo/panda.jpg')
 *   .pipe(file.createWriteStream())
 *   .on('error', function(err) {})
 *   .on('finish', function() {
 *     // The file upload is complete.
 *   });
 *
 * //-
 * // <h4>Uploading a File with gzip compression</h4>
 * //-
 * fs.createReadStream('/Users/stephen/site/index.html')
 *   .pipe(file.createWriteStream({ gzip: true }))
 *   .on('error', function(err) {})
 *   .on('finish', function() {
 *     // The file upload is complete.
 *   });
 *
 * //-
 * // Downloading the file with `createReadStream` will automatically decode the
 * // file.
 * //-
 *
 * //-
 * // <h4>Uploading a File with Metadata</h4>
 * //
 * // One last case you may run into is when you want to upload a file to your
 * // bucket and set its metadata at the same time. Like above, you can use
 * // {module:storage/bucket#upload} to do this, which is just a wrapper around
 * // the following.
 * //-
 * fs.createReadStream('/Users/stephen/Photos/birthday-at-the-zoo/panda.jpg')
 *   .pipe(file.createWriteStream({
 *     metadata: {
 *       contentType: 'image/jpeg',
 *       metadata: {
 *         custom: 'metadata'
 *       }
 *     }
 *   }))
 *   .on('error', function(err) {})
 *   .on('finish', function() {
 *     // The file upload is complete.
 *   });
 */
File.prototype.createWriteStream = function(options) {
  options = options || {};

  var self = this;

  var gzip = options.gzip;

  var metadata = options.metadata || {};
  if (gzip) {
    metadata.contentEncoding = 'gzip';
  }

  var crc32c = options.validation !== false;
  var md5 = options.validation !== false;

  if (is.string(options.validation)) {
    options.validation = options.validation.toLowerCase();
    crc32c = options.validation === 'crc32c';
    md5 = options.validation === 'md5';
  }

  // Collect data as it comes in to store in a hash. This is compared to the
  // checksum value on the returned metadata from the API.
  var validateStream = hashStreamValidation({
    crc32c: crc32c,
    md5: md5
  });

  var fileWriteStream = duplexify();

  var stream = streamEvents(pumpify([
    gzip ? zlib.createGzip() : through(),
    validateStream,
    fileWriteStream
  ]));

  // Wait until we've received data to determine what upload technique to use.
  stream.on('writing', function() {
    if (options.resumable === false) {
      self.startSimpleUpload_(fileWriteStream, metadata);
    } else {
      self.startResumableUpload_(fileWriteStream, metadata);
    }
  });

  // This is to preserve the `finish` event. We wait until the request stream
  // emits "complete", as that is when we do validation of the data. After that
  // is successful, we can allow the stream to naturally finish.
  //
  // Reference for tracking when we can use a non-hack solution:
  // https://github.com/nodejs/node/pull/2314
  fileWriteStream.on('prefinish', function() {
    stream.cork();
  });

  // Compare our hashed version vs the completed upload's version.
  fileWriteStream.on('complete', function() {
    var metadata = self.metadata;

    // If we're doing validation, assume the worst-- a data integrity mismatch.
    // If not, these tests won't be performed, and we can assume the best.
    var failed = crc32c || md5;

    if (crc32c && metadata.crc32c) {
      // We must remove the first four bytes from the returned checksum.
      // http://stackoverflow.com/questions/25096737/
      //   base64-encoding-of-crc32c-long-value
      failed = !validateStream.test('crc32c', metadata.crc32c.substr(4));
    }

    if (md5 && metadata.md5Hash) {
      failed = !validateStream.test('md5', metadata.md5Hash);
    }

    if (failed) {
      self.delete(function(err) {
        var code;
        var message;

        if (err) {
          code = 'FILE_NO_UPLOAD_DELETE';
          message = [
            'The uploaded data did not match the data from the server. As a',
            'precaution, we attempted to delete the file, but it was not',
            'successful. To be sure the content is the same, you should try',
            'removing the file manually, then uploading the file again.',
            '\n\nThe delete attempt failed with this message:',
            '\n\n  ' + err.message
          ].join(' ');
        } else {
          code = 'FILE_NO_UPLOAD';
          message = [
            'The uploaded data did not match the data from the server. As a',
            'precaution, the file has been deleted. To be sure the content',
            'is the same, you should try uploading the file again.'
          ].join(' ');
        }

        var error = new Error(message);
        error.code = code;
        error.errors = [err];

        fileWriteStream.destroy(error);
      });

      return;
    }

    stream.uncork();
  });

  return stream;
};

/**
 * Convenience method to download a file into memory or to a local destination.
 *
 * @param {object=} options - Optional configuration. The arguments match those
 *     passed to {module:storage/file#createReadStream}.
 * @param {string} options.destination - Local file path to write the file's
 *     contents to.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {buffer} callback.contents - The contents of a File.
 *
 * @example
 * //-
 * // Download a file into memory. The contents will be available as the second
 * // argument in the demonstration below, `contents`.
 * //-
 * file.download(function(err, contents) {});
 *
 * //-
 * // Download a file to a local destination.
 * //-
 * file.download({
 *   destination: '/Users/stephen/Desktop/file-backup.txt'
 * }, function(err) {});
 */
File.prototype.download = function(options, callback) {
  if (is.fn(options)) {
    callback = options;
    options = {};
  }

  callback = once(callback);

  var destination = options.destination;
  delete options.destination;

  var fileStream = this.createReadStream(options);

  if (destination) {
    fileStream
      .on('error', callback)
      .pipe(fs.createWriteStream(destination))
      .on('error', callback)
      .on('finish', callback);
  } else {
    fileStream
      .on('error', callback)
      .pipe(concat(callback.bind(null, null)));
  }
};

/**
 * Get a signed policy document to allow a user to upload data with a POST
 * request.
 *
 * @resource [Policy Document Reference]{@link https://cloud.google.com/storage/docs/reference-methods#policydocument}
 *
 * @throws {Error} If an expiration timestamp from the past is given.
 * @throws {Error} If options.equals has an array with less or more than two
 *     members.
 * @throws {Error} If options.startsWith has an array with less or more than two
 *     members.
 *
 * @param {object} options - Configuration object.
 * @param {array|array[]=} options.equals - Array of request parameters and
 *     their expected value (e.g. [['$<field>', '<value>']]). Values are
 *     translated into equality constraints in the conditions field of the
 *     policy document (e.g. ['eq', '$<field>', '<value>']). If only one
 *     equality condition is to be specified, options.equals can be a one-
 *     dimensional array (e.g. ['$<field>', '<value>']).
 * @param {*} options.expires - A timestamp when this policy will expire. Any
 *     value given is passed to `new Date()`.
 * @param {array|array[]=} options.startsWith - Array of request parameters and
 *     their expected prefixes (e.g. [['$<field>', '<value>']). Values are
 *     translated into starts-with constraints in the conditions field of the
 *     policy document (e.g. ['starts-with', '$<field>', '<value>']). If only
 *     one prefix condition is to be specified, options.startsWith can be a one-
 *     dimensional array (e.g. ['$<field>', '<value>']).
 * @param {string=} options.acl - ACL for the object from possibly predefined
 *     ACLs.
 * @param {string=} options.successRedirect - The URL to which the user client
 *     is redirected if the upload is successful.
 * @param {string=} options.successStatus - The status of the Google Storage
 *     response if the upload is successful (must be string).
 * @param {object=} options.contentLengthRange
 * @param {number} options.contentLengthRange.min - Minimum value for the
 *     request's content length.
 * @param {number} options.contentLengthRange.max - Maximum value for the
 *     request's content length.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {object} callback.policy - The document policy.
 *
 * @example
 * var options = {
 *   equals: ['$Content-Type', 'image/jpeg'],
 *   expires: '10-25-2022',
 *   contentLengthRange: {
 *     min: 0,
 *     max: 1024
 *   }
 * };
 *
 * file.getSignedPolicy(options, function(err, policy) {
 *   // policy.string: the policy document in plain text.
 *   // policy.base64: the policy document in base64.
 *   // policy.signature: the policy signature in base64.
 * });
 */
File.prototype.getSignedPolicy = function(options, callback) {
  var expires = new Date(options.expires);

  if (expires < Date.now()) {
    throw new Error('An expiration date cannot be in the past.');
  }

  var conditions = [
    ['eq', '$key', this.name],
    {
      bucket: this.bucket.name
    }
  ];

  if (is.array(options.equals)) {
    if (!is.array(options.equals[0])) {
      options.equals = [options.equals];
    }
    options.equals.forEach(function(condition) {
      if (!is.array(condition) || condition.length !== 2) {
        throw new Error('Equals condition must be an array of 2 elements.');
      }
      conditions.push(['eq', condition[0], condition[1]]);
    });
  }

  if (is.array(options.startsWith)) {
    if (!is.array(options.startsWith[0])) {
      options.startsWith = [options.startsWith];
    }
    options.startsWith.forEach(function(condition) {
      if (!is.array(condition) || condition.length !== 2) {
        throw new Error('StartsWith condition must be an array of 2 elements.');
      }
      conditions.push(['starts-with', condition[0], condition[1]]);
    });
  }

  if (options.acl) {
    conditions.push({
      acl: options.acl
    });
  }

  if (options.successRedirect) {
    conditions.push({
      success_action_redirect: options.successRedirect
    });
  }

  if (options.successStatus) {
    conditions.push({
      success_action_status: options.successStatus
    });
  }

  if (options.contentLengthRange) {
    var min = options.contentLengthRange.min;
    var max = options.contentLengthRange.max;
    if (!is.number(min) || !is.number(max)) {
      throw new Error('ContentLengthRange must have numeric min & max fields.');
    }
    conditions.push(['content-length-range', min, max]);
  }

  var policy = {
    expiration: expires.toISOString(),
    conditions: conditions
  };

  this.storage.getCredentials(function(err, credentials) {
    if (err) {
      callback(new SigningError(err.message));
      return;
    }

    if (!credentials.private_key) {
      var errorMessage = [
        'Could not find a `private_key`.',
        'Please verify you are authorized with this property available.'
      ].join(' ');

      callback(new SigningError(errorMessage));
      return;
    }

    var sign = crypto.createSign('RSA-SHA256');
    var policyString = JSON.stringify(policy);
    var policyBase64 = new Buffer(policyString).toString('base64');

    sign.update(policyBase64);

    var signature = sign.sign(credentials.private_key, 'base64');

    callback(null, {
      string: policyString,
      base64: policyBase64,
      signature: signature
    });
  });
};

/**
 * Get a signed URL to allow limited time access to the file.
 *
 * @resource [Signed URLs Reference]{@link https://cloud.google.com/storage/docs/access-control#Signed-URLs}
 *
 * @throws {Error} if an expiration timestamp from the past is given.
 *
 * @param {object} options - Configuration object.
 * @param {string} options.action - "read", "write", or "delete"
 * @param {string=} options.contentMd5 - The MD5 digest value in base64. If you
 *     provide this, the client must provide this HTTP header with this same
 *     value in its request.
 * @param {string=} options.contentType - If you provide this value, the client
 *     must provide this HTTP header set to the same value.
 * @param {*} options.expires - A timestamp when this link will expire. Any
 *     value given is passed to `new Date()`.
 * @param {string=} options.extensionHeaders - If these headers are used, the
 *     server will check to make sure that the client provides matching values.
 * @param {string=} options.promptSaveAs - The filename to prompt the user to
 *     save the file as when the signed url is accessed. This is ignored if
 *     options.responseDisposition is set.
 * @param {string=} options.responseDisposition - The
 *     response-content-disposition parameter (http://goo.gl/yMWxQV) of the
 *     signed url.
 * @param {string=} options.responseType - The response-content-type parameter
 *     of the signed url.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {string} callback.url - The signed URL.
 *
 * @example
 * //-
 * // Generate a URL that allows temporary access to download your file.
 * //-
 * var request = require('request');
 *
 * file.getSignedUrl({
 *   action: 'read',
 *   expires: '03-17-2025'
 * }, function(err, url) {
 *   if (err) {
 *     console.error(err);
 *     return;
 *   }
 *
 *   // The file is now available to read from this URL.
 *   request(url, function(err, resp) {
 *     // resp.statusCode = 200
 *   });
 * });
 *
 * //-
 * // Generate a URL to allow write permissions. This means anyone with this URL
 * // can send a POST request with new data that will overwrite the file.
 * //-
 * file.getSignedUrl({
 *   action: 'write',
 *   expires: '03-17-2025'
 * }, function(err, url) {
 *   if (err) {
 *     console.error(err);
 *     return;
 *   }
 *
 *   // The file is now available to be written to.
 *   var writeStream = request.post(url);
 *   writeStream.end('New data');
 *
 *   writeStream.on('complete', function(resp) {
 *     // Confirm the new content was saved.
 *     file.download(function(err, fileContents) {
 *       console.log('Contents:', fileContents.toString());
 *       // Contents: New data
 *     });
 *   });
 * });
 */
File.prototype.getSignedUrl = function(options, callback) {
  var expires = new Date(options.expires);
  var expiresInSeconds = Math.round(expires / 1000); // The API expects seconds.

  if (expires < Date.now()) {
    throw new Error('An expiration date cannot be in the past.');
  }

  options.action = {
    read: 'GET',
    write: 'PUT',
    delete: 'DELETE'
  }[options.action];

  var name = encodeURIComponent(this.name);

  options.resource = '/' + this.bucket.name + '/' + name;

  this.storage.getCredentials(function(err, credentials) {
    if (err) {
      callback(new SigningError(err.message));
      return;
    }

    if (!credentials.private_key || !credentials.client_email) {
      var errorMessage = [
        'Could not find a `private_key` or `client_email`.',
        'Please verify you are authorized with these credentials available.'
      ].join(' ');

      callback(new SigningError(errorMessage));
      return;
    }

    var sign = crypto.createSign('RSA-SHA256');
    sign.update([
      options.action,
      (options.contentMd5 || ''),
      (options.contentType || ''),
      expiresInSeconds,
      (options.extensionHeaders || '') + options.resource
    ].join('\n'));
    var signature = sign.sign(credentials.private_key, 'base64');

    var responseContentType = '';
    if (is.string(options.responseType)) {
      responseContentType =
        '&response-content-type=' +
        encodeURIComponent(options.responseType);
    }

    var responseContentDisposition = '';
    if (is.string(options.promptSaveAs)) {
      responseContentDisposition =
        '&response-content-disposition=attachment; filename="' +
        encodeURIComponent(options.promptSaveAs) + '"';
    }
    if (is.string(options.responseDisposition)) {
      responseContentDisposition =
        '&response-content-disposition=' +
        encodeURIComponent(options.responseDisposition);
    }

    callback(null, [
      'https://storage.googleapis.com' + options.resource,
      '?GoogleAccessId=' + credentials.client_email,
      '&Expires=' + expiresInSeconds,
      '&Signature=' + encodeURIComponent(signature),
      responseContentType,
      responseContentDisposition
    ].join(''));
  });
};

/**
 * Make a file private to the project and remove all other permissions.
 * Set `options.strict` to true to make the file private to only the owner.
 *
 * @resource [Objects: patch API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/patch}
 *
 * @param {object=} options - The configuration object.
 * @param {boolean=} options.strict - If true, set the file to be private to
 *     only the owner user. Otherwise, it will be private to the project.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 *
 * @example
 *
 * //-
 * // Set the file private so only project maintainers can see and modify it.
 * //-
 * file.makePrivate(function(err) {});
 *
 * //-
 * // Set the file private so only the owner can see and modify it.
 * //-
 * file.makePrivate({ strict: true }, function(err) {});
 */
File.prototype.makePrivate = function(options, callback) {
  var self = this;

  if (is.fn(options)) {
    callback = options;
    options = {};
  }

  var query = {
    predefinedAcl: options.strict ? 'private' : 'projectPrivate'
  };

  // You aren't allowed to set both predefinedAcl & acl properties on a file, so
  // acl must explicitly be nullified, destroying all previous acls on the file.
  var metadata = {
    acl: null
  };

  callback = callback || util.noop;

  this.request({
    method: 'PATCH',
    uri: '',
    qs: query,
    json: metadata
  }, function(err, resp) {
    if (err) {
      callback(err, resp);
      return;
    }

    self.metadata = resp;

    callback(null, resp);
  });
};

/**
 * Set a file to be publicly readable and maintain all previous permissions.
 *
 * @resource [ObjectAccessControls: insert API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objectAccessControls/insert}
 *
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * file.makePublic(function(err, apiResponse) {});
 */
File.prototype.makePublic = function(callback) {
  callback = callback || util.noop;

  this.acl.add({
    entity: 'allUsers',
    role: 'READER'
  }, function(err, resp) {
    callback(err, resp);
  });
};

/**
 * Move this file to another location. By default, this will move the file to
 * the same bucket, but you can choose to move it to another Bucket by providing
 * either a Bucket or File object.
 *
 * **Warning**:
 * There is currently no atomic `move` method in the Google Cloud Storage API,
 * so this method is a composition of {module:storage/file#copy} (to the new
 * location) and {module:storage/file#delete} (from the old location). While
 * unlikely, it is possible that an error returned to your callback could be
 * triggered from either one of these API calls failing, which could leave a
 * duplicate file lingering.
 *
 * @resource [Objects: copy API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/copy}
 *
 * @throws {Error} If the destination file is not provided.
 *
 * @param {string|module:storage/bucket|module:storage/file} destination -
 *     Destination file.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {module:storage/file} callback.destinationFile - The destination File.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * //-
 * // You can pass in a variety of types for the destination.
 * //
 * // For all of the below examples, assume we are working with the following
 * // Bucket and File objects.
 * //-
 * var bucket = gcs.bucket('my-bucket');
 * var file = bucket.file('my-image.png');
 *
 * //-
 * // If you pass in a string for the destination, the file is moved to its
 * // current bucket, under the new name provided.
 * //-
 * file.move('my-image-new.png', function(err, destinationFile, apiResponse) {
 *   // `my-bucket` no longer contains:
 *   // - "my-image.png"
 *   // but contains instead:
 *   // - "my-image-new.png"
 *
 *   // `destinationFile` is an instance of a File object that refers to your
 *   // new file.
 * });
 *
 * //-
 * // If you pass in a Bucket object, the file will be moved to that bucket
 * // using the same name.
 * //-
 * var anotherBucket = gcs.bucket('another-bucket');
 *
 * file.move(anotherBucket, function(err, destinationFile, apiResponse) {
 *   // `my-bucket` no longer contains:
 *   // - "my-image.png"
 *   //
 *   // `another-bucket` now contains:
 *   // - "my-image.png"
 *
 *   // `destinationFile` is an instance of a File object that refers to your
 *   // new file.
 * });
 *
 * //-
 * // If you pass in a File object, you have complete control over the new
 * // bucket and filename.
 * //-
 * var anotherFile = anotherBucket.file('my-awesome-image.png');
 *
 * file.move(anotherFile, function(err, destinationFile, apiResponse) {
 *   // `my-bucket` no longer contains:
 *   // - "my-image.png"
 *   //
 *   // `another-bucket` now contains:
 *   // - "my-awesome-image.png"
 *
 *   // Note:
 *   // The `destinationFile` parameter is equal to `anotherFile`.
 * });
 */
File.prototype.move = function(destination, callback) {
  var self = this;

  callback = callback || util.noop;

  this.copy(destination, function(err, destinationFile, apiResponse) {
    if (err) {
      callback(err, null, apiResponse);
      return;
    }

    self.delete(function(err, apiResponse) {
      callback(err, destinationFile, apiResponse);
    });
  });
};

/**
 * This creates a gcs-resumable-upload upload stream.
 *
 * @resource [gcs-resumable-upload]{@link https://github.com/stephenplusplus/gcs-resumable-upload}
 *
 * @param {Duplexify} stream - Duplexify stream of data to pipe to the file.
 * @param {object=} metadata - Optional metadata to set on the file.
 *
 * @private
 */
File.prototype.startResumableUpload_ = function(dup, metadata) {
  var self = this;

  var uploadStream = resumableUpload({
    authClient: this.storage.authClient,
    bucket: this.bucket.name,
    file: this.name,
    generation: this.generation,
    metadata: metadata || {}
  });

  uploadStream
    .on('response', function(resp, metadata) {
      if (metadata) {
        self.metadata = metadata;
      }
    })
    .on('finish', function() {
      dup.emit('complete');
    });

  dup.setWritable(uploadStream);
};

/**
 * Takes a readable stream and pipes it to a remote file. Unlike
 * `startResumableUpload_`, which uses the resumable upload technique, this
 * method uses a simple upload (all or nothing).
 *
 * @param {Duplexify} dup - Duplexify stream of data to pipe to the file.
 * @param {object=} metadata - Optional metadata to set on the file.
 *
 * @private
 */
File.prototype.startSimpleUpload_ = function(dup, metadata) {
  var self = this;

  var reqOpts = {
    qs: {
      name: self.name
    },
    uri: format('{uploadBaseUrl}/{bucket}/o', {
      uploadBaseUrl: STORAGE_UPLOAD_BASE_URL,
      bucket: self.bucket.name
    })
  };

  if (is.defined(this.generation)) {
    reqOpts.qs.ifGenerationMatch = this.generation;
  }

  util.makeWritableStream(dup, {
    makeAuthenticatedRequest: this.storage.makeAuthenticatedRequest,
    metadata: metadata,
    request: reqOpts
  }, function(data) {
    self.metadata = data;
    dup.emit('complete');
  });
};

module.exports = File;
