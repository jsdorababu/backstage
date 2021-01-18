/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ConfigReader } from '@backstage/config';
import { msw } from '@backstage/test-utils';
import fs from 'fs';
import { rest } from 'msw';
import { setupServer } from 'msw/node';
import path from 'path';
import { NotModifiedError } from '../errors';
import { BitbucketUrlReader } from './BitbucketUrlReader';
import { ReadTreeResponseFactory } from './tree';

const treeResponseFactory = ReadTreeResponseFactory.create({
  config: new ConfigReader({}),
});

const bitbucketProcessor = new BitbucketUrlReader(
  { host: 'bitbucket.org', apiBaseUrl: 'https://api.bitbucket.org/2.0' },
  { treeResponseFactory },
);

const hostedBitbucketProcessor = new BitbucketUrlReader(
  {
    host: 'bitbucket.mycompany.net',
    apiBaseUrl: 'https://api.bitbucket.mycompany.net/rest/api/1.0',
  },
  { treeResponseFactory },
);

describe('BitbucketUrlReader', () => {
  describe('implementation', () => {
    it('rejects unknown targets', async () => {
      await expect(
        bitbucketProcessor.read('https://not.bitbucket.com/apa'),
      ).rejects.toThrow(
        'Incorrect URL: https://not.bitbucket.com/apa, Error: Invalid Bitbucket URL or file path',
      );
    });
  });

  describe('readTree', () => {
    const worker = setupServer();
    msw.setupDefaultHandlers(worker);

    const repoBuffer = fs.readFileSync(
      path.resolve(
        'src',
        'reading',
        '__fixtures__',
        'bitbucket-repo-with-commit-hash.zip',
      ),
    );

    const privateBitbucketRepoBuffer = fs.readFileSync(
      path.resolve(
        'src',
        'reading',
        '__fixtures__',
        'bitbucket-server-repo.zip',
      ),
    );

    beforeEach(() => {
      worker.use(
        rest.get(
          'https://api.bitbucket.org/2.0/repositories/backstage/mock',
          (_, res, ctx) =>
            res(
              ctx.status(200),
              ctx.json({
                mainbranch: {
                  type: 'branch',
                  name: 'master',
                },
              }),
            ),
        ),
        rest.get(
          'https://bitbucket.org/backstage/mock/get/master.zip',
          (_, res, ctx) =>
            res(
              ctx.status(200),
              ctx.set('Content-Type', 'application/zip'),
              ctx.body(repoBuffer),
            ),
        ),
        rest.get(
          'https://api.bitbucket.org/2.0/repositories/backstage/mock/commits/master',
          (_, res, ctx) =>
            res(
              ctx.status(200),
              ctx.json({
                values: [{ hash: '12ab34cd56ef78gh90ij12kl34mn56op78qr90st' }],
              }),
            ),
        ),
        rest.get(
          'https://api.bitbucket.mycompany.net/rest/api/1.0/projects/backstage/repos/mock/archive?format=zip&prefix=mock&path=docs',
          (_, res, ctx) =>
            res(
              ctx.status(200),
              ctx.set('Content-Type', 'application/zip'),
              ctx.body(privateBitbucketRepoBuffer),
            ),
        ),
        rest.get(
          'https://api.bitbucket.mycompany.net/rest/api/1.0/repositories/backstage/mock/commits/some-branch',
          (_, res, ctx) =>
            res(
              ctx.status(200),
              ctx.json({
                values: [{ hash: '12ab34cd56ef78gh90ij12kl34mn56op78qr90st' }],
              }),
            ),
        ),
      );
    });

    it('returns the wanted files from an archive', async () => {
      const response = await bitbucketProcessor.readTree(
        'https://bitbucket.org/backstage/mock/src/master',
      );

      expect(response.sha).toBe('12ab34cd56ef');

      const files = await response.files();

      expect(files.length).toBe(2);
      const indexMarkdownFile = await files[0].content();
      const mkDocsFile = await files[1].content();

      expect(indexMarkdownFile.toString()).toBe('# Test\n');
      expect(mkDocsFile.toString()).toBe('site_name: Test\n');
    });

    it('uses private bitbucket host', async () => {
      const response = await hostedBitbucketProcessor.readTree(
        'https://bitbucket.mycompany.net/projects/backstage/repos/mock/browse/docs?at=some-branch',
      );

      expect(response.sha).toBe('12ab34cd56ef');

      const files = await response.files();

      expect(files.length).toBe(1);
      const indexMarkdownFile = await files[0].content();

      expect(indexMarkdownFile.toString()).toBe('# Test\n');
    });

    it('returns the wanted files from an archive with a subpath', async () => {
      const response = await bitbucketProcessor.readTree(
        'https://bitbucket.org/backstage/mock/src/master/docs',
      );

      expect(response.sha).toBe('12ab34cd56ef');

      const files = await response.files();

      expect(files.length).toBe(1);
      const indexMarkdownFile = await files[0].content();

      expect(indexMarkdownFile.toString()).toBe('# Test\n');
    });

    it('throws a NotModifiedError when given a sha in options', async () => {
      const fnBitbucket = async () => {
        await bitbucketProcessor.readTree(
          'https://bitbucket.org/backstage/mock',
          { sha: '12ab34cd56ef' },
        );
      };

      await expect(fnBitbucket).rejects.toThrow(NotModifiedError);
    });

    it('should not throw a NotModifiedError when given an outdated sha in options', async () => {
      const response = await bitbucketProcessor.readTree(
        'https://bitbucket.org/backstage/mock',
        { sha: 'outdatedSha123abc' },
      );

      expect(response.sha).toBe('12ab34cd56ef');
    });
  });
});
