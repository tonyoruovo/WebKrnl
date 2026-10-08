// Worker entry for the configured processor (dedicated and shared).
import { serveProcessor } from '../../src/processor/worker';

import { configured } from './configured.processor';

serveProcessor(configured);
