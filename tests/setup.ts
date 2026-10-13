import { afterEach } from 'bun:test';
import { contractViolations } from '../src/api/spec/check.js';
import { closeOpenRepos } from './helpers.js';

// Every API response in the suite is held to the OpenAPI spec.
process.env.ASYNCUP_CONTRACT_CHECK = '1';

afterEach(() => {
  closeOpenRepos();
  const found = contractViolations.splice(0);
  if (found.length) throw new Error(`API responses broke the spec:\n${found.join('\n')}`);
});
