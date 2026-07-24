import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  allocateHeadingSlugs,
  assertPublicHttpUrl,
  checkExternalUrl,
  createPinnedLookup,
  extractLinks,
  fetchWithRedirects,
  isPublicIp,
  markdownAnchorsFromSource,
  pathInsideRepository,
  permanentRequestFailure,
  redactedErrorMessage,
  redactedLocalTarget,
  redactedUrl,
  requestFailureReason,
  requestHttpStatus,
  validateLocalLink,
} from './check-documentation-links.mjs';

function callLookup(lookupImplementation, hostname, options = {}) {
  return new Promise((resolve, reject) => {
    lookupImplementation(hostname, options, (error, address, family) => {
      if (error) {
        reject(error);
      } else {
        resolve({ address, family });
      }
    });
  });
}

test('extractLinks handles Markdown and HTML links without reading code', () => {
  const source = [
    '[balanced](docs/file_(one).md "title")',
    String.raw`[escaped](docs/file\(two\).md)`,
    '[![diagram](images/diagram(one).png)](guide.md#part)',
    '[reference][ref]',
    '[ref]: reference(target).md "Reference title"',
    '<https://example.com/path?q=secret>',
    '<img src="images/a(b).png" alt="example">',
    '<a',
    '  href="multiline.html">',
    '  multiline',
    '</a>',
    '😀 before a longer fence',
    '````javascript',
    '[fenced](missing-fenced.md)',
    '`````',
    '',
    '> ~~~~',
    '> [quoted fence](missing-quoted.md)',
    '> ~~~~~',
    '',
    '    [indented](missing-indented.md)',
    '`[inline](missing-inline.md)`',
  ].join('\n');

  const links = extractLinks(source, 'docs/example.md');
  assert.deepEqual(
    links.map(({ target }) => target),
    [
      'docs/file_(one).md',
      'docs/file(two).md',
      'images/diagram(one).png',
      'guide.md#part',
      'reference(target).md',
      'https://example.com/path?q=secret',
      'images/a(b).png',
      'multiline.html',
    ],
  );
  assert.equal(links.some(({ target }) => target.includes('missing-')), false);
});

test('extractLinks preserves authored occurrences and block semantics', () => {
  const source = [
    'paragraph',
    '    [paragraph continuation](paragraph.md)',
    '- list item',
    '    [list continuation](list.md)',
    '',
    '    [root code](missing-root-code.md)',
    '',
    '[repeat](same.md) and [repeat](same.md)',
    '[empty]()',
    '[reference]:',
    '  continued.md "title"',
    '[use][reference]',
    '<person@example.com>',
    '<a data-href="ignored.html" href=kept.html>kept</a>',
    '<source srcset="ignored.png 2x" src="media.png">',
    '````',
    '```',
    '[short fence](missing-short-fence.md)',
    '`````',
    '[after fence](after.md)',
    '````',
    '[unclosed](missing-unclosed.md)',
  ].join('\n');

  assert.deepEqual(
    extractLinks(source, 'fixtures.md').map(({ target }) => target),
    [
      'paragraph.md',
      'list.md',
      'same.md',
      'same.md',
      '',
      'continued.md',
      'mailto:person@example.com',
      'kept.html',
      'media.png',
      'after.md',
    ],
  );
});

test('inline code uses exact backtick runs and unmatched runs remain text', () => {
  const source = [
    '`` [ignored](missing.md) ` still code `` [kept](kept.md)',
    '` unmatched [also kept](also-kept.md)',
  ].join('\n');
  assert.deepEqual(
    extractLinks(source, 'inline-code.md').map(({ target }) => target),
    ['kept.md', 'also-kept.md'],
  );
});

test('link line numbers use the indexed source offsets', () => {
  const links = extractLinks(
    '[first](first.md)\nplain text\n[third](third.md)\n',
    'line-numbers.md',
  );
  assert.deepEqual(
    links.map(({ line, target }) => ({ line, target })),
    [
      { line: 1, target: 'first.md' },
      { line: 3, target: 'third.md' },
    ],
  );
});

test('GitHub-style heading allocation avoids explicit suffix collisions', () => {
  assert.deepEqual(
    [...allocateHeadingSlugs(['Foo', 'Foo-1', 'Foo', 'Foo-1'])],
    ['foo', 'foo-1', 'foo-2', 'foo-1-1'],
  );
  assert.deepEqual(
    [...markdownAnchorsFromSource('# Bar\n# Bar\n# Bar-1\n')],
    ['bar', 'bar-1', 'bar-1-1'],
  );
});

test('IP policy permits globally routable addresses and rejects special ranges', () => {
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);

  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.1.1',
    '127.0.0.1',
    '169.254.169.254',
    '192.0.2.1',
    '198.51.100.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '2001:db8::1',
    '3fff::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '4000::1',
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
});

test('permanent request failures are classified and returned without retry', async () => {
  const nestedError = new Error('fetch failed', {
    cause: Object.assign(new Error('DNS failed'), { code: 'ENOTFOUND' }),
  });
  assert.equal(requestFailureReason(nestedError), 'ENOTFOUND');
  assert.equal(permanentRequestFailure('ENOTFOUND'), true);
  assert.equal(permanentRequestFailure('ERR_INVALID_URL'), true);
  assert.equal(permanentRequestFailure('ECONNRESET'), false);

  let requests = 0;
  const result = await checkExternalUrl('https://example.com', {
    requestTimeoutMs: 1_000,
    requester: async () => {
      requests += 1;
      throw nestedError;
    },
    retries: 3,
  });
  assert.deepEqual(result, { outcome: 'failed', reason: 'ENOTFOUND' });
  assert.equal(requests, 1);

  const wrappedPolicyError = new Error('request wrapper', {
    cause: new Error('private-host'),
  });
  assert.equal(requestFailureReason(wrappedPolicyError), 'private-host');
});

test('HEAD rejection falls back to one headers-only GET', async () => {
  const methods = [];
  const result = await checkExternalUrl('https://example.com', {
    requestTimeoutMs: 1_000,
    requester: async (_url, _timeout, method) => {
      methods.push(method);
      return method === 'HEAD' ? 405 : 204;
    },
    retries: 2,
  });
  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.deepEqual(result, { outcome: 'passed', status: 204 });
});

test('reported URL forms redact credentials, query values, and fragments', () => {
  const external = redactedUrl(
    'https://user:password@example.com/path?filter=hidden-value#private-fragment',
  );
  assert.equal(external, 'https://example.com/path?<redacted>');
  assert.doesNotMatch(external, /user|password|hidden-value|private-fragment/u);

  const local = redactedLocalTarget('guide.md?filter=hidden-value#safe-anchor');
  assert.equal(local, 'guide.md?<redacted>#safe-anchor');
  assert.doesNotMatch(local, /hidden-value/u);

  const errorMessage = redactedErrorMessage(
    new Error(
      'request https://user:password@example.com/path?filter=hidden-value#fragment failed',
    ),
  );
  assert.doesNotMatch(errorMessage, /user|password|hidden-value|fragment/u);
});

test('local validation follows real paths and rejects a symlink escape', (context) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'arcanos-doc-links-'));
  const repository = join(temporaryRoot, 'repository');
  const documentation = join(repository, 'docs');
  const outside = join(temporaryRoot, 'outside');

  try {
    mkdirSync(documentation, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(documentation, 'source.md'), '# Source\n', 'utf8');
    writeFileSync(join(outside, 'target.md'), '# Target\n', 'utf8');
    try {
      symlinkSync(
        outside,
        join(documentation, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (error?.code === 'EPERM') {
        context.skip('creating symlinks is not permitted in this environment');
        return;
      }
      throw error;
    }

    const issue = validateLocalLink(
      {
        file: 'docs/source.md',
        line: 1,
        target: 'escape/target.md',
      },
      repository,
    );
    assert.equal(issue?.message, 'target escapes the repository');
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('repository containment rejects absolute relative results and encoded Windows roots', (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows drive and UNC containment regression');
    return;
  }

  assert.equal(pathInsideRepository('D:\\outside', 'C:\\repository'), false);
  assert.equal(
    pathInsideRepository('\\\\server\\share\\target.md', 'C:\\repository'),
    false,
  );

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'arcanos-doc-links-'));
  const documentation = join(temporaryRoot, 'docs');
  try {
    mkdirSync(documentation, { recursive: true });
    writeFileSync(join(documentation, 'source.md'), '# Source\n', 'utf8');

    for (const target of [
      '%44:%5Coutside%5Ctarget.md',
      '%5C%5Cserver%5Cshare%5Ctarget.md',
    ]) {
      const issue = validateLocalLink(
        {
          file: 'docs/source.md',
          line: 1,
          target,
        },
        temporaryRoot,
      );
      assert.equal(issue?.message, 'target escapes the repository');
    }
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('pinned lookup rejects mixed answers and returns validated addresses', async () => {
  const publicLookup = createPinnedLookup(async (hostname, options) => {
    assert.equal(hostname, 'example.com');
    assert.deepEqual(options, { all: true, verbatim: true });
    return [{ address: '93.184.216.34', family: 4 }];
  });
  assert.deepEqual(
    await callLookup(publicLookup, 'example.com'),
    { address: '93.184.216.34', family: 4 },
  );
  assert.deepEqual(
    await callLookup(publicLookup, 'example.com', { all: true }),
    {
      address: [{ address: '93.184.216.34', family: 4 }],
      family: undefined,
    },
  );

  const mixedLookup = createPinnedLookup(async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await assert.rejects(
    callLookup(mixedLookup, 'example.com'),
    (error) => error.message === 'private-host',
  );

  const mismatchedFamilyLookup = createPinnedLookup(async () => [
    { address: '93.184.216.34', family: 6 },
  ]);
  await assert.rejects(
    callLookup(mismatchedFamilyLookup, 'example.com'),
    (error) => error.message === 'private-host',
  );
});

test('direct private addresses and private redirect targets are never requested', async () => {
  assert.throws(
    () => assertPublicHttpUrl(new URL('http://127.0.0.1/private')),
    (error) => error.message === 'private-host',
  );

  let requests = 0;
  const requestImplementation = (_options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => {
      requests += 1;
      onResponse({
        destroy() {},
        headers: { location: 'http://[::1]/private' },
        resume() {},
        statusCode: 302,
      });
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  await assert.rejects(
    fetchWithRedirects(
      'https://example.com/start',
      1_000,
      'HEAD',
      {
        requestImplementation,
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      },
    ),
    (error) => error.message === 'private-host',
  );
  assert.equal(requests, 1);
});

test('malformed redirect locations fail definitively without retry', async () => {
  let requests = 0;
  const requestImplementation = (_options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => {
      requests += 1;
      onResponse({
        destroy() {},
        headers: { location: 'http://[' },
        resume() {},
        statusCode: 302,
      });
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  const result = await checkExternalUrl('https://example.com/start', {
    requestTimeoutMs: 1_000,
    requester: (rawUrl, requestTimeoutMs, method) => fetchWithRedirects(
      rawUrl,
      requestTimeoutMs,
      method,
      {
        requestImplementation,
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      },
    ),
    retries: 3,
  });

  assert.deepEqual(result, { outcome: 'failed', reason: 'ERR_INVALID_URL' });
  assert.equal(requests, 1);
});

test('HTTP requests resolve at connect time through the pinned lookup', async () => {
  let resolverCalls = 0;
  let capturedOptions;
  const resolver = async () => {
    resolverCalls += 1;
    return [{ address: '93.184.216.34', family: 4 }];
  };
  const requestImplementation = (options, onResponse) => {
    capturedOptions = options;
    const request = new EventEmitter();
    request.end = () => {
      options.lookup(options.hostname, {}, (error, address, family) => {
        assert.ifError(error);
        assert.equal(address, '93.184.216.34');
        assert.equal(family, 4);
        onResponse({
          destroy() {},
          headers: {},
          resume() {},
          statusCode: 204,
        });
      });
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };

  assert.equal(resolverCalls, 0);
  const result = await requestHttpStatus(
    new URL('https://example.com:8443/docs?view=summary'),
    1_000,
    'HEAD',
    { requestImplementation, resolver },
  );
  assert.deepEqual(result, { location: undefined, status: 204 });
  assert.equal(resolverCalls, 1);
  assert.equal(capturedOptions.agent, false);
  assert.equal(capturedOptions.headers.Connection, 'close');
  assert.equal(capturedOptions.hostname, 'example.com');
  assert.equal(capturedOptions.path, '/docs?view=summary');
  assert.equal(capturedOptions.port, '8443');
  assert.equal(capturedOptions.servername, 'example.com');
});

test('one request timeout includes DNS and prevents a later connection', async () => {
  let connections = 0;
  const requestImplementation = (options) => {
    const request = new EventEmitter();
    request.end = () => {
      options.lookup(options.hostname, {}, () => {
        connections += 1;
      });
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };

  await assert.rejects(
    requestHttpStatus(
      new URL('https://example.com'),
      20,
      'HEAD',
      {
        requestImplementation,
        resolver: () => new Promise(() => {}),
      },
    ),
    (error) => error.message === 'request-timeout',
  );
  assert.equal(connections, 0);
});
