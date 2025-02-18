/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

import log from 'lighthouse-logger';

/** @typedef {import('@sentry/node').Breadcrumb} Breadcrumb */
/** @typedef {import('@sentry/node').NodeClient} NodeClient */
/** @typedef {import('@sentry/node').NodeOptions} NodeOptions */
/** @typedef {import('@sentry/node').Severity} Severity */

const SENTRY_URL = 'https://a6bb0da87ee048cc9ae2a345fc09ab2e:63a7029f46f74265981b7e005e0f69f8@sentry.io/174697';

// Per-run chance of capturing errors (if enabled).
const SAMPLE_RATE = 0.01;

/** @type {Array<{pattern: RegExp, rate: number}>} */
const SAMPLED_ERRORS = [
  // Error code based sampling. Delete if still unused after 2019-01-01.
  // e.g.: {pattern: /No.*node with given id/, rate: 0.01},
];

const noop = () => { };

/**
 * A delegate for sentry so that environments without error reporting enabled will use
 * noop functions and environments with error reporting will call the actual Sentry methods.
 */
const sentryDelegate = {
  init,
  /** @type {(message: string, level?: Severity) => void} */
  captureMessage: noop,
  /** @type {(breadcrumb: Breadcrumb) => void} */
  captureBreadcrumb: noop,
  /** @type {() => any} */
  getContext: noop,
  /** @type {(error: Error, options: {level?: string, tags?: {[key: string]: any}, extra?: {[key: string]: any}}) => Promise<void>} */
  captureException: async () => { },
  _shouldSample() {
    return SAMPLE_RATE >= Math.random();
  },
};

/**
 * When called, replaces noops with actual Sentry implementation.
 * @param {{url: string, flags: LH.CliFlags, environmentData: NodeOptions}} opts
 */
async function init(opts) {
  // If error reporting is disabled, leave the functions as a noop
  if (!opts.flags.enableErrorReporting) {
    return;
  }

  // If not selected for samping, leave the functions as a noop.
  if (!sentryDelegate._shouldSample()) {
    return;
  }

  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      ...opts.environmentData,
      dsn: SENTRY_URL,
    });

    const extras = {
      ...opts.flags.throttling,
      channel: opts.flags.channel || 'cli',
      url: opts.url,
      formFactor: opts.flags.formFactor,
      throttlingMethod: opts.flags.throttlingMethod,
    };
    Sentry.setExtras(extras);

    // Have each delegate function call the corresponding sentry function by default
    sentryDelegate.captureMessage = (...args) => Sentry.captureMessage(...args);
    sentryDelegate.captureBreadcrumb = (...args) => Sentry.addBreadcrumb(...args);
    sentryDelegate.getContext = () => extras;

    // Keep a record of exceptions per audit/gatherer so we can just report once
    const sentryExceptionCache = new Map();
    // Special case captureException to return a Promise so we don't process.exit too early
    sentryDelegate.captureException = async (err, opts = {}) => {
      // Ignore if there wasn't an error
      if (!err) return;

      // Ignore expected errors
      // @ts-expect-error Non-standard property added to flag error as not needing capturing.
      if (err.expected) return;

      const tags = opts.tags || {};
      if (tags.audit) {
        const key = `audit-${tags.audit}-${err.message}`;
        if (sentryExceptionCache.has(key)) return;
        sentryExceptionCache.set(key, true);
      }

      if (tags.gatherer) {
        const key = `gatherer-${tags.gatherer}-${err.message}`;
        if (sentryExceptionCache.has(key)) return;
        sentryExceptionCache.set(key, true);
      }

      // Sample known errors that occur at a high frequency.
      const sampledErrorMatch = SAMPLED_ERRORS.find(sample => sample.pattern.test(err.message));
      if (sampledErrorMatch && sampledErrorMatch.rate <= Math.random()) return;

      // @ts-expect-error - properties added to protocol method LighthouseErrors.
      if (err.protocolMethod) {
        // Protocol errors all share same stack trace, so add more to fingerprint
        // @ts-expect-error - properties added to protocol method LighthouseErrors.
        opts.fingerprint = ['{{ default }}', err.protocolMethod, err.protocolError];

        opts.tags = opts.tags || {};
        // @ts-expect-error - properties added to protocol method LighthouseErrors.
        opts.tags.protocolMethod = err.protocolMethod;
      }

      Sentry.withScope(scope => {
        if (opts.level) {
          // @ts-expect-error - allow any string.
          scope.setLevel(opts.level);
        }
        if (opts.tags) {
          scope.setTags(opts.tags);
        }
        if (opts.extra) {
          scope.setExtras(opts.extra);
        }
        Sentry.captureException(err);
      });
    };
  } catch (e) {
    log.warn(
      'sentry',
      'Could not load Sentry, errors will not be reported.'
    );
  }
}

export const Sentry = sentryDelegate;
