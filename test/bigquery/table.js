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
var crypto = require('crypto');
var extend = require('extend');
var mockery = require('mockery');
var nodeutil = require('util');
var stream = require('stream');

var File = require('../../lib/storage/file.js');
var ServiceObject = require('../../lib/common/service-object.js');
var util = require('../../lib/common/util.js');

function FakeFile(a, b) {
  this.request = util.noop;
  File.call(this, a, b);
}

var makeWritableStreamOverride;
var fakeUtil = extend({}, util, {
  makeWritableStream: function() {
    var args = [].slice.call(arguments);
    (makeWritableStreamOverride || util.makeWritableStream).apply(null, args);
  }
});

var extended = false;
var fakeStreamRouter = {
  extend: function(Class, methods) {
    if (Class.name !== 'Table') {
      return;
    }

    methods = arrify(methods);
    assert.equal(Class.name, 'Table');
    assert.deepEqual(methods, ['getRows']);
    extended = true;
  }
};

function FakeServiceObject() {
  this.calledWith_ = arguments;
  ServiceObject.apply(this, arguments);
}

nodeutil.inherits(FakeServiceObject, ServiceObject);

describe('BigQuery/Table', function() {
  var DATASET = {
    id: 'dataset-id',
    createTable: util.noop,
    bigQuery: {
      projectId: 'project-id',
      job: function(id) {
        return { id: id };
      }
    }
  };

  var SCHEMA_OBJECT = {
    fields: [
      { name: 'id', type: 'integer' },
      { name: 'breed', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'dob', type: 'timestamp' }
    ]
  };
  var SCHEMA_STRING = 'id:integer,breed,name,dob:timestamp';

  var Table;
  var TABLE_ID = 'kittens';
  var table;
  var tableOverrides = {};

  before(function() {
    mockery.registerMock('../storage/file.js', FakeFile);
    mockery.registerMock('../common/service-object.js', FakeServiceObject);
    mockery.registerMock('../common/stream-router.js', fakeStreamRouter);
    mockery.registerMock('../common/util.js', fakeUtil);
    mockery.enable({
      useCleanCache: true,
      warnOnUnregistered: false
    });

    Table = require('../../lib/bigquery/table.js');

    var tableCached = extend(true, {}, Table);

    // Override all util methods, allowing them to be mocked. Overrides are
    // removed before each test.
    Object.keys(Table).forEach(function(tableMethod) {
      if (typeof Table[tableMethod] !== 'function') {
        return;
      }

      Table[tableMethod] = function() {
        return (tableOverrides[tableMethod] || tableCached[tableMethod])
          .apply(this, arguments);
      };
    });
  });

  after(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  beforeEach(function() {
    makeWritableStreamOverride = null;
    tableOverrides = {};
    table = new Table(DATASET, TABLE_ID);
  });

  describe('instantiation', function() {
    it('should extend the correct methods', function() {
      assert(extended); // See `fakeStreamRouter.extend`
    });

    it('should inherit from ServiceObject', function(done) {
      var datasetInstance = extend({}, DATASET, {
        createTable: {
          bind: function(context) {
            assert.strictEqual(context, datasetInstance);
            done();
          }
        }
      });

      var table = new Table(datasetInstance, TABLE_ID);
      assert(table instanceof ServiceObject);

      var calledWith = table.calledWith_[0];

      assert.strictEqual(calledWith.parent, datasetInstance);
      assert.strictEqual(calledWith.baseUrl, '/tables');
      assert.strictEqual(calledWith.id, TABLE_ID);
      assert.deepEqual(calledWith.methods, {
        create: true,
        delete: true,
        exists: true,
        get: true,
        getMetadata: true
      });
    });
  });

  describe('createSchemaFromString_', function() {
    it('should create a schema object from a string', function() {
      assert.deepEqual(
        Table.createSchemaFromString_(SCHEMA_STRING), SCHEMA_OBJECT);
    });
  });

  describe('mergeSchemaWithRows_', function() {
    it('should merge the schema and flatten the rows', function() {
      var rows = [
        {
          f: [
            { v: 3 },
            { v: 'dogbreed' },
            { v: 'dogname' },
            { v: '234234' }
          ]
        },
        {
          f: [
            { v: 4 },
            { v: 'dogbreed2' },
            { v: 'dogname2' },
            { v: '2342342' }
          ]
        }
      ];

      assert.deepEqual(Table.mergeSchemaWithRows_(SCHEMA_OBJECT, rows), [
        { id: 3, breed: 'dogbreed', name: 'dogname', dob: '234234' },
        { id: 4, breed: 'dogbreed2', name: 'dogname2', dob: '2342342' }
      ]);
    });
  });

  describe('copy', function() {
    var DEST_TABLE;

    before(function() {
      DEST_TABLE = new Table(DATASET, 'destination-table');
    });

    it('should throw if a destination is not a Table', function() {
      assert.throws(function() {
        table.copy();
      }, /Destination must be a Table/);

      assert.throws(function() {
        table.copy({});
      }, /Destination must be a Table/);

      assert.throws(function() {
        table.copy(function() {});
      }, /Destination must be a Table/);
    });

    it('should send correct request to the API', function(done) {
      table.bigQuery.request = function(reqOpts) {
        assert.equal(reqOpts.method, 'POST');
        assert.equal(reqOpts.uri, '/jobs');
        assert.deepEqual(reqOpts.json, {
          configuration: {
            copy: {
              a: 'b',
              c: 'd',
              destinationTable: {
                datasetId: DEST_TABLE.dataset.id,
                projectId: DEST_TABLE.bigQuery.projectId,
                tableId: DEST_TABLE.id
              },
              sourceTable: {
                datasetId: table.dataset.id,
                projectId: table.bigQuery.projectId,
                tableId: table.id
              }
            }
          }
        });

        done();
      };

      table.copy(DEST_TABLE, { a: 'b', c: 'd' }, assert.ifError);
    });

    it('should create and return a Job', function(done) {
      var jobId = 'job-id';

      table.bigQuery.request = function(reqOpts, callback) {
        callback(null, { jobReference: { jobId: jobId } });
      };

      table.copy(DEST_TABLE, function(err, job) {
        assert.ifError(err);
        assert.equal(job.id, jobId);
        done();
      });
    });

    it('should assign metadata on the job', function(done) {
      var jobMetadata = { jobReference: { jobId: 'job-id' }, a: 'b', c: 'd' };

      table.bigQuery.request = function(reqOpts, callback) {
        callback(null, jobMetadata);
      };

      table.copy(DEST_TABLE, function(err, job) {
        assert.ifError(err);
        assert.deepEqual(job.metadata, jobMetadata);
        done();
      });
    });

    it('should accept just a destination and callback', function(done) {
      table.bigQuery.request = function(reqOpts, callback) {
        callback(null, { jobReference: { jobId: 'job-id' } });
      };

      table.copy(DEST_TABLE, done);
    });

    it('should pass an error to the callback', function(done) {
      var error = new Error('Error.');

      table.bigQuery.request = function(reqOpts, callback) {
        callback(error);
      };

      table.copy(DEST_TABLE, function(err) {
        assert.equal(err, error);
        done();
      });
    });

    it('should pass an apiResponse to the callback', function(done) {
      var jobMetadata = { jobReference: { jobId: 'job-id' }, a: 'b', c: 'd' };

      table.bigQuery.request = function(reqOpts, callback) {
        callback(null, jobMetadata);
      };

      table.copy(DEST_TABLE, function(err, job, apiResponse) {
        assert.ifError(err);
        assert.deepEqual(apiResponse, jobMetadata);
        done();
      });
    });
  });

  describe('createReadStream', function() {
    it('should return table.getRows()', function() {
      var uniqueReturnValue = 'abc123';

      table.getRows = function() {
        assert.equal(arguments.length, 0);
        return uniqueReturnValue;
      };

      assert.equal(table.createReadStream(), uniqueReturnValue);
    });
  });

  describe('createWriteStream', function() {
    it('should use a string as the file type', function(done) {
      var fileType = 'csv';

      makeWritableStreamOverride = function(stream, options) {
        var load = options.metadata.configuration.load;
        assert.equal(load.sourceFormat, 'CSV');
        done();
      };

      table.createWriteStream(fileType).emit('writing');
    });

    it('should format a schema', function(done) {
      var expectedSchema = {};

      tableOverrides.createSchemaFromString_ = function(string) {
        assert.strictEqual(string, SCHEMA_STRING);
        return expectedSchema;
      };

      makeWritableStreamOverride = function(stream, options) {
        var load = options.metadata.configuration.load;
        assert.deepEqual(load.schema, expectedSchema);
        done();
      };

      table.createWriteStream({ schema: SCHEMA_STRING }).emit('writing');
    });

    it('should throw if a given source format is not recognized', function() {
      assert.throws(function() {
        table.createWriteStream('zip');
      }, /Source format not recognized/);

      assert.throws(function() {
        table.createWriteStream({
          sourceFormat: 'zip'
        });
      }, /Source format not recognized/);

      assert.doesNotThrow(function() {
        table.createWriteStream();
        table.createWriteStream({});
      });
    });

    it('should return a stream', function() {
      assert(table.createWriteStream() instanceof stream.Stream);
    });

    describe('writable stream', function() {
      it('should make a writable stream when written to', function(done) {
        var stream;

        makeWritableStreamOverride = function(s) {
          assert.equal(s, stream);
          done();
        };

        stream = table.createWriteStream();
        stream.emit('writing');
      });

      it('should pass the connection', function(done) {
        makeWritableStreamOverride = function(stream, options) {
          assert.deepEqual(options.connection, table.connection);
          done();
        };

        table.createWriteStream().emit('writing');
      });

      it('should pass extended metadata', function(done) {
        makeWritableStreamOverride = function(stream, options) {
          assert.deepEqual(options.metadata, {
            configuration: {
              load: {
                a: 'b',
                c: 'd',
                destinationTable: {
                  projectId: table.bigQuery.projectId,
                  datasetId: table.dataset.id,
                  tableId: table.id
                }
              }
            }
          });
          done();
        };

        table.createWriteStream({ a: 'b', c: 'd' }).emit('writing');
      });

      it('should pass the correct request uri', function(done) {
        makeWritableStreamOverride = function(stream, options) {
          var uri = 'https://www.googleapis.com/upload/bigquery/v2/projects/' +
            table.bigQuery.projectId + '/jobs';
          assert.equal(options.request.uri, uri);
          done();
        };

        table.createWriteStream().emit('writing');
      });

      it('should create a job and emit it with complete', function(done) {
        var jobId = 'job-id';
        var metadata = { jobReference: { jobId: jobId }, a: 'b', c: 'd' };

        table.bigQuery.job = function(id) {
          return { id: id };
        };

        makeWritableStreamOverride = function(stream, options, callback) {
          callback(metadata);
        };

        table.createWriteStream()
          .on('complete', function(job) {
            assert.equal(job.id, jobId);
            assert.deepEqual(job.metadata, metadata);
            done();
          })
          .emit('writing');
      });
    });
  });

  describe('export', function() {
    var FILE = new FakeFile({
      name: 'bucket-name',
      makeReq_: util.noop,
    }, 'file.json');

    beforeEach(function() {
      table.bigQuery.job = function(id) {
        return { id: id };
      };
    });

    it('should send the correct API request', function(done) {
      table.bigQuery.request = function(reqOpts) {
        assert.equal(reqOpts.method, 'POST');
        assert.equal(reqOpts.uri, '/jobs');
        assert.deepEqual(reqOpts.json.configuration.extract.sourceTable, {
          datasetId: table.dataset.id,
          projectId: table.bigQuery.projectId,
          tableId: table.id
        });

        done();
      };

      table.export(FILE, assert.ifError);
    });

    it('should accept just a destination and a callback', function(done) {
      table.bigQuery.request = function(reqOpts, callback) {
        callback(null, { jobReference: { jobId: 'job-id' }});
      };

      table.export(FILE, done);
    });

    it('should parse out full gs:// urls from files', function(done) {
      table.bigQuery.request = function(reqOpts) {
        assert.deepEqual(reqOpts.json.configuration.extract.destinationUris, [
          'gs://' + FILE.bucket.name + '/' + FILE.name
        ]);
        done();
      };

      table.export(FILE, done);
    });

    it('should throw if a destination is not a File', function() {
      assert.throws(function() {
        table.export({}, util.noop);
      }, /Destination must be a File object/);

      assert.throws(function() {
        table.export([FILE, {}], util.noop);
      }, /Destination must be a File object/);
    });

    it('should detect file format if a format is not provided', function(done) {
      table.bigQuery.request = function(reqOpts) {
        var destFormat = reqOpts.json.configuration.extract.destinationFormat;
        assert.equal(destFormat, 'NEWLINE_DELIMITED_JSON');
        done();
      };

      table.export(FILE, assert.ifError);
    });

    it('should assign the provided format if matched', function(done) {
      table.bigQuery.request = function(reqOpts) {
        var extract = reqOpts.json.configuration.extract;
        assert.equal(extract.destinationFormat, 'CSV');
        assert.strictEqual(extract.format, undefined);
        done();
      };

      table.export(FILE, { format: 'csv' }, assert.ifError);
    });

    it('should throw if a provided format is not recognized', function() {
      assert.throws(function() {
        table.export(FILE, { format: 'zip' }, util.noop);
      }, /Destination format not recognized/);
    });

    it('should assign GZIP compression with gzip: true', function(done) {
      table.bigQuery.request = function(reqOpts) {
        assert.equal(reqOpts.json.configuration.extract.compression, 'GZIP');
        assert.strictEqual(reqOpts.json.configuration.extract.gzip, undefined);
        done();
      };

      table.export(FILE, { gzip: true }, util.noop);
    });

    it('should execute the callback with error', function(done) {
      var error = new Error('Error.');

      table.bigQuery.request = function(reqOpts, callback) {
        callback(error);
      };

      table.export(FILE, function(err) {
        assert.strictEqual(err, error);
        done();
      });
    });

    it('should create a Job and returns it to the callback', function(done) {
      var jobMetadata = { jobReference: { jobId: 'job-id' }, a: 'b', c: 'd' };

      table.bigQuery.request = function(reqOpts, callback) {
        callback(null, jobMetadata);
      };

      table.export(FILE, function(err, job) {
        assert.ifError(err);
        assert.deepEqual(job.metadata, jobMetadata);
        done();
      });
    });

    it('should return apiResponse to callback', function(done) {
      var jobMetadata = { jobReference: { jobId: 'job-id' }, a: 'b', c: 'd' };

      table.bigQuery.request = function(reqOpts, callback) {
        callback(null, jobMetadata);
      };

      table.export(FILE, function(err, job, apiResponse) {
        assert.ifError(err);
        assert.deepEqual(apiResponse, jobMetadata);
        done();
      });
    });
  });

  describe('getRows', function() {
    it('should accept just a callback', function(done) {
      table.request = function(reqOpts, callback) {
        callback(null, {});
      };
      table.getRows(done);
    });

    it('should make correct API request', function(done) {
      var options = { a: 'b', c: 'd' };

      table.request = function(reqOpts, callback) {
        assert.strictEqual(reqOpts.uri, '/data');
        assert.strictEqual(reqOpts.qs, options);
        callback(null, {});
      };

      table.getRows(options, done);
    });

    it('should execute callback with error & API response', function(done) {
      var apiResponse = {};
      var error = new Error('Error.');

      table.request = function(reqOpts, callback) {
        callback(error, apiResponse);
      };

      table.getRows(function(err, rows, nextQuery, apiResponse_) {
        assert.strictEqual(err, error);
        assert.strictEqual(rows, null);
        assert.strictEqual(nextQuery, null);
        assert.strictEqual(apiResponse_, apiResponse);

        done();
      });
    });

    describe('refreshing metadata', function() {
      // Using "Stephen" so you know who to blame for these tests.
      var rows = [{ f: [{ v: 'stephen' }] }];
      var schema = { fields: [{ name: 'name', type: 'string' }] };

      beforeEach(function() {
        table.request = function(reqOpts, callback) {
          // Respond with a row, so it grabs the schema.
          // Use setImmediate to let our getMetadata overwrite process.
          setImmediate(callback, null, { rows: rows });
        };
      });

      it('should refresh', function(done) {
        // Step 1: makes the request.
        table.getRows(responseHandler);

        // Step 2: refreshes the metadata to pull down the schema.
        table.getMetadata = function(callback) {
          table.metadata = { schema: schema };
          callback();
        };

        // Step 3: execute original complete handler with schema-merged rows.
        function responseHandler(err, rows) {
          assert.ifError(err);
          assert.deepEqual(rows, [{ name: 'stephen' }]);
          done();
        }
      });

      it('should execute callback from refreshing metadata', function(done) {
        var apiResponse = {};
        var error = new Error('Error.');

        // Step 1: makes the request.
        table.getRows(responseHandler);

        // Step 2: refreshes the metadata to pull down the schema.
        table.getMetadata = function(callback) {
          callback(error, {}, apiResponse);
        };

        // Step 3: execute original complete handler with schema-merged rows.
        function responseHandler(err, rows, nextQuery, apiResponse_) {
          assert.strictEqual(err, error);
          assert.strictEqual(rows, null);
          assert.strictEqual(nextQuery, null);
          assert.strictEqual(apiResponse_, apiResponse);
          done();
        }
      });
    });

    it('should return schema-merged rows', function(done) {
      var rows = [{ f: [{ v: 'stephen' }] }];
      var schema = { fields: [{ name: 'name', type: 'string' }] };
      table.metadata = { schema: schema };

      table.request = function(reqOpts, callback) {
        callback(null, { rows: rows });
      };

      table.getRows(function(err, rows) {
        assert.ifError(err);
        assert.deepEqual(rows, [{ name: 'stephen' }]);
        done();
      });
    });

    it('should return apiResponse in callback', function(done) {
      var rows = [{ f: [{ v: 'stephen' }] }];
      var schema = { fields: [{ name: 'name', type: 'string' }] };
      table.metadata = { schema: schema };

      table.request = function(reqOpts, callback) {
        callback(null, { rows: rows });
      };

      table.getRows(function(err, rows, nextQuery, apiResponse) {
        assert.ifError(err);
        assert.deepEqual(apiResponse, { rows: [{ f: [{ v: 'stephen' }] }] });
        done();
      });
    });

    it('should pass nextQuery if pageToken is returned', function(done) {
      var options = { a: 'b', c: 'd' };
      var pageToken = 'token';

      // Set a schema so it doesn't try to refresh the metadata.
      table.metadata = { schema: {} };

      table.request = function(reqOpts, callback) {
        callback(null, { pageToken: pageToken });
      };

      table.getRows(options, function(err, rows, nextQuery) {
        assert.ifError(err);
        assert.deepEqual(nextQuery, { a: 'b', c: 'd', pageToken: pageToken });
        // Original object isn't affected.
        assert.deepEqual(options, { a: 'b', c: 'd' });
        done();
      });
    });
  });

  describe('import', function() {
    var FILEPATH = require.resolve('../testdata/response_get.json');
    var FILE = new FakeFile({
      name: 'bucket-name',
      makeReq_: util.noop
    }, 'file.json');

    it('should accept just a File and a callback', function(done) {
      var mockJob = { id: 'foo' };

      table.createWriteStream = function() {
        var ws = new stream.Writable();
        setImmediate(function() {
          ws.emit('complete', mockJob);
          ws.end();
        });
        return ws;
      };

      table.import(FILEPATH, function(err, job) {
        assert.strictEqual(err, null);
        assert.deepEqual(job, mockJob);
        done();
      });
    });

    it('should return a stream when a string is given', function() {
      table.createWriteStream = function() {
        return new stream.Writable();
      };

      assert(table.import(FILEPATH) instanceof stream.Stream);
    });

    it('should infer the file format from the given filepath', function(done) {
      table.createWriteStream = function(metadata) {
        assert.equal(metadata.sourceFormat, 'NEWLINE_DELIMITED_JSON');
        var ws = new stream.Writable();
        setImmediate(function() {
          ws.emit('complete');
          ws.end();
        });
        return ws;
      };

      table.import(FILEPATH, done);
    });

    it('should not infer the file format if one is given', function(done) {
      table.createWriteStream = function(metadata) {
        assert.equal(metadata.sourceFormat, 'CSV');
        var ws = new stream.Writable();
        setImmediate(function() {
          ws.emit('complete');
          ws.end();
        });
        return ws;
      };

      table.import(FILEPATH, { sourceFormat: 'CSV' }, done);
    });

    it('should throw if a File object is not provided', function() {
      assert.throws(function() {
        table.import({});
      }, /Source must be a File object/);
    });

    it('should convert File objects to gs:// urls', function(done) {
      table.bigQuery.request = function(reqOpts) {
        var sourceUri = reqOpts.json.configuration.load.sourceUris[0];
        assert.equal(sourceUri, 'gs://' + FILE.bucket.name + '/' + FILE.name);
        done();
      };

      table.import(FILE, assert.ifError);
    });

    it('should infer the file format from a File object', function(done) {
      table.bigQuery.request = function(reqOpts) {
        var sourceFormat = reqOpts.json.configuration.load.sourceFormat;
        assert.equal(sourceFormat, 'NEWLINE_DELIMITED_JSON');
        done();
      };

      table.import(FILE, assert.ifError);
    });

    it('should not override a provided format with a File', function(done) {
      table.bigQuery.request = function(reqOpts) {
        var sourceFormat = reqOpts.json.configuration.load.sourceFormat;
        assert.equal(sourceFormat, 'CSV');
        done();
      };

      table.import(FILE, { sourceFormat: 'CSV' }, assert.ifError);
    });

    it('should execute the callback with error', function(done) {
      var error = new Error('Error.');

      table.bigQuery.request = function(reqOpts, callback) {
        callback(error);
      };

      table.import(FILE, function(err) {
        assert.equal(err, error);
        done();
      });
    });

    it('should create a Job and return it to the callback', function(done) {
      var jobMetadata = { jobReference: { jobId: 'job-id' }, a: 'b', c: 'd' };

      table.bigQuery.request = function(reqOpts, callback) {
        callback(null, jobMetadata);
      };

      table.import(FILE, function(err, job) {
        assert.ifError(err);
        assert.deepEqual(job.metadata, jobMetadata);
        done();
      });
    });

    it('should return apiResponse to callback', function(done) {
      var jobMetadata = { jobReference: { jobId: 'job-id' }, a: 'b', c: 'd' };

      table.bigQuery.request = function(reqOpts, callback) {
        callback(null, jobMetadata);
      };

      table.import(FILE, function(err, job, apiResponse) {
        assert.ifError(err);
        assert.deepEqual(apiResponse, jobMetadata);
        done();
      });
    });
  });

  describe('insert', function() {
    var data = [
      { state: 'MI', gender: 'M', year: '2015', name: 'Berkley', count: '0' },
      { state: 'MI', gender: 'M', year: '2015', name: 'Berkley', count: '0' },
      { state: 'MI', gender: 'M', year: '2015', name: 'Berkley', count: '0' },
      { state: 'MI', gender: 'M', year: '2015', name: 'Berkley', count: '0' },
      { state: 'MI', gender: 'M', year: '2015', name: 'Berkley', count: '0' }
    ];

    var dataApiFormat = {
      rows: data.map(function(row) {
        var rowObject = {};
        var md5 = crypto.createHash('md5');
        md5.update(JSON.stringify(row));
        rowObject.insertId = md5.digest('hex');
        rowObject.json = row;
        return rowObject;
      })
    };

    it('should save data', function(done) {
      table.request = function(reqOpts) {
        assert.equal(reqOpts.method, 'POST');
        assert.equal(reqOpts.uri, '/insertAll');
        assert.deepEqual(reqOpts.json, dataApiFormat);
        done();
      };

      table.insert(data, done);
    });

    it('should execute callback with API response', function(done) {
      var apiResponse = { insertErrors: [] };

      table.request = function(reqOpts, callback) {
        callback(null, apiResponse);
      };

      table.insert(data, function(err, insertErrors, apiResponse_) {
        assert.ifError(err);
        assert.deepEqual(insertErrors, []);
        assert.strictEqual(apiResponse_, apiResponse);
        done();
      });
    });

    it('should execute callback with error & API response', function(done) {
      var error = new Error('Error.');
      var apiResponse = {};

      table.request = function(reqOpts, callback) {
        callback(error, apiResponse);
      };

      table.insert(data, function(err, insertErrors, apiResponse_) {
        assert.strictEqual(err, error);
        assert.strictEqual(insertErrors, null);
        assert.strictEqual(apiResponse_, apiResponse);
        done();
      });
    });

    it('should return insert failures to the callback', function(done) {
      var row0Error = { message: 'Error.', reason: 'notFound' };
      var row1Error = { message: 'Error.', reason: 'notFound' };

      table.request = function(reqOpts, callback) {
        callback(null, {
          insertErrors: [
            { index: 0, errors: [row0Error] },
            { index: 1, errors: [row1Error] }
          ]
        });
      };

      table.insert(data, function(err, insertErrors) {
        assert.ifError(err);

        assert.deepEqual(insertErrors, [
          { row: dataApiFormat.rows[0].json, errors: [row0Error] },
          { row: dataApiFormat.rows[1].json, errors: [row1Error] }
        ]);

        done();
      });
    });
  });

  describe('query', function() {
    it('should pass args through to datasetInstance.query()', function(done) {
      table.dataset.query = function(a, b) {
        assert.equal(a, 'a');
        assert.equal(b, 'b');
        done();
      };

      table.query('a', 'b');
    });
  });

  describe('setMetadata', function() {
    var METADATA = { a: 'b', c: 'd' };

    it('should send request to the api', function(done) {
      table.request = function(reqOpts) {
        assert.strictEqual(reqOpts.method, 'PUT');
        assert.strictEqual(reqOpts.uri, '');
        assert.deepEqual(reqOpts.json, METADATA);
        done();
      };

      table.setMetadata(METADATA, assert.ifError);
    });

    it('should convert a name to a friendly name', function(done) {
      var name = 'a new name';

      table.request = function(reqOpts) {
        assert.equal(reqOpts.json.friendlyName, name);
        done();
      };

      table.setMetadata({ name: name }, assert.ifError);
    });

    it('should accept a schema', function(done) {
      table.request = function(reqOpts) {
        assert.deepEqual(reqOpts.json.schema, {
          fields: [{ name: 'schema', type: 'string' }]
        });
        done();
      };
      table.setMetadata({ schema: 'schema' });
    });

    it('should execute callback with error & API response', function(done) {
      var error = new Error('Error.');
      var apiResponse = {};

      table.request = function(reqOpts, callback) {
        callback(error, apiResponse);
      };

      table.setMetadata(METADATA, function(err, apiResponse_) {
        assert.strictEqual(err, error);
        assert.strictEqual(apiResponse_, apiResponse);
        done();
      });
    });

    describe('metadata', function() {
      beforeEach(function() {
        table.request = function(reqOpts, callback) {
          callback(null, METADATA);
        };
      });

      it('should update metadata on Table object', function(done) {
        table.setMetadata(METADATA, function(err) {
          assert.ifError(err);
          assert.deepEqual(table.metadata, METADATA);
          done();
        });
      });

      it('should execute callback with metadata', function(done) {
        table.setMetadata(METADATA, function(err, apiResponse) {
          assert.ifError(err);
          assert.deepEqual(apiResponse, METADATA);
          done();
        });
      });

      it('should execute callback with apiResponse', function(done) {
        table.setMetadata(METADATA, function(err, apiResponse) {
          assert.ifError(err);
          assert.deepEqual(apiResponse, METADATA);
          done();
        });
      });
    });
  });
});
