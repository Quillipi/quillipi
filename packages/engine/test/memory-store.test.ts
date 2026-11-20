import { MemoryStore } from '../src/memory-store.js';
import { KARAN, testNotebookStore } from './store-contract.js';

testNotebookStore('memory', async () => new MemoryStore(KARAN));
