/*!
 * Copyright 2016 Google Inc. All Rights Reserved.
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

import * as assert from 'assert';
import {describe, it} from 'mocha';
import * as uuid from 'uuid';
import {ErrorsApiTransport} from './errors-transport';
import * as proxyquire from 'proxyquire';
import * as winston from 'winston';
import {Logging, Entry} from '@google-cloud/logging';
import * as instrumentation from '@google-cloud/logging/build/src/utils/instrumentation';

const logging = new Logging();

const WRITE_CONSISTENCY_DELAY_MS = 90000;

const UUID = uuid.v4();
function logName(name: string) {
  return `${UUID}_${name}`;
}

describe('LoggingWinston', function () {
  this.timeout(WRITE_CONSISTENCY_DELAY_MS);
  const testTimestamp = new Date();

  // type TestData

  const commonTestData: TestData[] = [
    {
      args: ['first'],
      level: 'info',
      verify: (entry: Entry) => {
        assert.deepStrictEqual(entry.data, {
          message: 'first',
          // TODO: investigate why this behavior has changed
          // in @google-cloud/logging, see:
          // https://github.com/googleapis/nodejs-logging/issues/818
          metadata: [null],
        });
      },
    },

    {
      args: ['second'],
      level: 'info',
      verify: (entry: Entry) => {
        assert.deepStrictEqual(entry.data, {
          message: 'second',
          // TODO: investigate why this behavior has changed
          // in @google-cloud/logging, see:
          // https://github.com/googleapis/nodejs-logging/issues/818
          metadata: null,
        });
      },
    },
    {
      args: ['third', {testTimestamp}],
      level: 'info',
      verify: (entry: Entry) => {
        assert.deepStrictEqual(entry.data, {
          message: 'third',
          metadata: {
            testTimestamp: String(testTimestamp),
          },
        });
      },
    },
  ];

  interface TestData {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any[];
    level: string;
    verify: (entry: Entry) => void;
  }

  describe('log', () => {
    const LoggingWinston = proxyquire('../src/index', {winston}).LoggingWinston;

    it.skip('should properly write log entries', async () => {
      const testData = commonTestData.concat([
        {
          args: [new Error('fourth')],
          level: 'error',
          verify: (entry: Entry) => {
            assert(
              (
                entry.data as {
                  message: string;
                }
              ).message.startsWith('fourth Error:')
            );
          },
        },
        {
          args: [
            {
              level: 'error',
              message: 'fifth message',
              error: new Error('fifth'),
            },
          ],
          level: 'log',
          verify: (entry: Entry) => {
            assert(
              (
                entry.data as {
                  message: string;
                }
              ).message.startsWith('fifth message')
            );
          },
        },
      ] as TestData[]);

      const LOG_NAME = logName('logging_winston_system_tests_1');

      const logger = winston.createLogger({
        transports: [new LoggingWinston({logName: LOG_NAME})],
      });

      const start = Date.now();
      testData.forEach(test => {
        // logger does not have index signature.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (logger as any)[test.level].apply(logger, test.args);
      });

      const entries = await pollLogs(
        LOG_NAME,
        start,
        testData.length,
        WRITE_CONSISTENCY_DELAY_MS
      );
      assert.strictEqual(entries.length, testData.length);
      entries.reverse().forEach((entry, index) => {
        const test = testData[index];
        test.verify(entry as {} as Entry);
      });
    });

    it('should work correctly with winston formats', async () => {
      const MESSAGE = 'A message that should be padded';
      const start = Date.now();
      const LOG_NAME = logName('logging_winston_system_tests_2');
      const logger = winston.createLogger({
        transports: [new LoggingWinston({logName: LOG_NAME})],
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.padLevels()
        ),
      });
      // Make sure we logging below with error severity so the further query
      // will not return additional diagnostic record which is always written with INFO severity
      logger.error(MESSAGE);

      const entries = await pollLogs(
        LOG_NAME,
        start,
        2,
        WRITE_CONSISTENCY_DELAY_MS
      );
      entries.forEach(entry => {
        assert.ok(entry.data);
        if (
          Object.prototype.hasOwnProperty.call(
            entry.data,
            instrumentation.DIAGNOSTIC_INFO_KEY
          )
        ) {
          const info =
            entry.data[instrumentation.DIAGNOSTIC_INFO_KEY][
              instrumentation.INSTRUMENTATION_SOURCE_KEY
            ];
          assert.equal(info[0].name, 'nodejs');
          assert.equal(info[1].name, 'nodejs-winston');
        } else {
          const data = entry.data as {message: string};
          assert.strictEqual(data.message, `   ${MESSAGE}`);
        }
      });
    });
  });

  describe('ErrorReporting', () => {
    const LOG_NAME = logName('logging_winston_error_reporting_system_tests');
    const ERROR_REPORTING_POLL_TIMEOUT = WRITE_CONSISTENCY_DELAY_MS;
    const errorsTransport = new ErrorsApiTransport();

    it('reports errors', async () => {
      const start = Date.now();
      const service = `logging-winston-system-test-winston3-${UUID}`;
      const LoggingWinston = proxyquire('../src/index', {
        winston,
      }).LoggingWinston;

      const logger = winston.createLogger({
        transports: [
          new LoggingWinston({
            logName: LOG_NAME,
            serviceContext: {service, version: 'none'},
          }),
        ],
      });

      const message = `an error at ${Date.now()}`;

      logger.error(new Error(message));

      const errors = await errorsTransport.pollForNewEvents(
        service,
        start,
        ERROR_REPORTING_POLL_TIMEOUT
      );

      assert.strictEqual(errors.length, 1);
      const errEvent = errors[0];

      assert.strictEqual(errEvent.serviceContext.service, service);

      assert(errEvent.message.startsWith(message));
    });
  });
});

// polls for the entire array of entries to be greater than logTime.
function pollLogs(
  logName: string,
  logTime: number,
  size: number,
  timeout: number
) {
  const p = new Promise<Entry[]>((resolve, reject) => {
    const end = Date.now() + timeout;
    loop();

    function loop() {
      setTimeout(() => {
        logging.log(logName).getEntries(
          {
            pageSize: size,
          },
          (err, entries) => {
            if (!entries || entries.length < size) return loop();

            const {receiveTimestamp} = (entries[entries.length - 1].metadata ||
              {}) as {receiveTimestamp: {seconds: number; nanos: number}};
            const timeMilliseconds =
              receiveTimestamp.seconds * 1000 + receiveTimestamp.nanos * 1e-6;

            if (timeMilliseconds >= logTime) {
              return resolve(entries);
            }

            if (Date.now() > end) {
              return reject(new Error('timeout'));
            }
            loop();
          }
        );
      }, 500);
    }
  });

  return p;
}
