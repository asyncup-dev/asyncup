import { afterEach } from 'bun:test';
import { closeOpenRepos } from './helpers.js';

afterEach(() => closeOpenRepos());
