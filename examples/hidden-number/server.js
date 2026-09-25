import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../../server/index.js';
import * as hiddenNumber from './game.js';

const here = path.dirname(fileURLToPath(import.meta.url));
createGameServer({ games: { 'hidden-number': hiddenNumber }, clientDir: path.join(here, 'client') });
